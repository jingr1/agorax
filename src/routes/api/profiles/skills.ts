/**
 * Per-profile skills listing — reads directly from the profile's local
 * `skills/` directory and `config.yaml` `skills.disabled` list.
 * No dashboard (:9119) dependency.
 *
 *   GET /api/profiles/skills?name=<profile>
 */
import fs from 'node:fs'
import pathMod from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  readProfile,
  resolveProfileHermesHome,
} from '../../../server/profiles-browser'

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

type SkillItem = {
  name: string
  description: string
  category: string
  enabled: boolean
  path: string
}

function getSkillsDisabledSet(config: Record<string, unknown>): Set<string> {
  const skills = config.skills
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    return new Set()
  }
  const disabled = (skills as Record<string, unknown>).disabled
  if (!Array.isArray(disabled)) return new Set()
  return new Set(
    disabled.filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    ),
  )
}

function listLocalSkills(
  profilePath: string,
  disabledSet: Set<string>,
): SkillItem[] {
  const skillsDir = pathMod.join(profilePath, 'skills')
  const results: SkillItem[] = []
  if (!fs.existsSync(skillsDir)) return results

  let categoryEntries: Array<fs.Dirent> = []
  try {
    categoryEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const cat of categoryEntries) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue
    const catPath = pathMod.join(skillsDir, cat.name)
    let skillEntries: Array<fs.Dirent> = []
    try {
      skillEntries = fs.readdirSync(catPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const skill of skillEntries) {
      if (!skill.isDirectory() && !skill.isSymbolicLink()) continue
      if (skill.name.startsWith('.')) continue
      const skillPath = pathMod.join(catPath, skill.name)
      const skillMdPath = pathMod.join(skillPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      let description = ''
      try {
        const raw = fs.readFileSync(skillMdPath, 'utf-8')
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/^description:\s*(.+?)\s*$/m)
          if (descMatch) {
            description = descMatch[1].replace(/^["']|["']$/g, '')
          }
        }
      } catch {
        // ignore
      }

      results.push({
        name: skill.name,
        description,
        category: cat.name,
        enabled: !disabledSet.has(skill.name),
        path: skillPath,
      })
    }
  }
  return results
}

export const Route = createFileRoute('/api/profiles/skills')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const url = new URL(request.url)
          const profile = (url.searchParams.get('name') || '').trim()
          if (!profile || !PROFILE_NAME_RE.test(profile)) {
            return json(
              { error: 'A valid profile name is required' },
              { status: 400 },
            )
          }

          let detail
          try {
            detail = readProfile(profile)
          } catch {
            return json(
              { error: `Profile "${profile}" not found` },
              { status: 404 },
            )
          }

          const profilePath = resolveProfileHermesHome(profile)
          const disabledSet = getSkillsDisabledSet(detail.config)
          const items = listLocalSkills(profilePath, disabledSet)

          return json({ profile, items })
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
