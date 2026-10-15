/**
 * Skill detail content — mirrors WebUI `/api/skills/content`.
 * Lazy-loads full SKILL.md (+ optional linked file) so the list endpoint
 * stays metadata-only.
 *
 *   GET /api/skills/content?name=<skill>&profile=<optional>&file=<optional>
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  getActiveProfileName,
  resolveProfileHermesHome,
} from '../../../server/profiles-browser'

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/

function getSkillsDir(profileName?: string): string {
  if (process.env.HERMES_SKILLS_DIR) return process.env.HERMES_SKILLS_DIR
  try {
    return path.join(
      resolveProfileHermesHome(
        profileName?.trim() || getActiveProfileName() || 'default',
      ),
      'skills',
    )
  } catch {
    return path.join(
      process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'),
      'skills',
    )
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

async function findSkillDir(
  skillsRoot: string,
  name: string,
): Promise<string | null> {
  const candidates = [name]
  if (name.includes(':')) {
    const bare = name.split(':').slice(1).join(':')
    if (bare) candidates.push(bare)
  }

  for (const candidate of candidates) {
    const direct = path.join(skillsRoot, candidate)
    try {
      await fs.access(path.join(direct, 'SKILL.md'))
      if (isPathInside(skillsRoot, direct)) return direct
    } catch {
      // continue
    }
  }

  let categoryEntries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    categoryEntries = (await fs.readdir(skillsRoot, {
      withFileTypes: true,
    })) as unknown as Array<{ name: string; isDirectory: () => boolean }>
  } catch {
    return null
  }

  for (const cat of categoryEntries) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue
    const catPath = path.join(skillsRoot, cat.name)

    for (const candidate of candidates) {
      const nested = path.join(catPath, candidate)
      try {
        await fs.access(path.join(nested, 'SKILL.md'))
        if (isPathInside(skillsRoot, nested)) return nested
      } catch {
        // continue
      }
    }

    let skillEntries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      skillEntries = (await fs.readdir(catPath, {
        withFileTypes: true,
      })) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      continue
    }

    for (const skill of skillEntries) {
      const isDir =
        skill.isDirectory() ||
        Boolean(
          (skill as { isSymbolicLink?: () => boolean }).isSymbolicLink?.(),
        )
      if (!isDir || skill.name.startsWith('.')) continue
      if (skill.name !== name && !candidates.includes(skill.name)) continue
      const skillPath = path.join(catPath, skill.name)
      try {
        await fs.access(path.join(skillPath, 'SKILL.md'))
        return skillPath
      } catch {
        // continue
      }
    }
  }

  return null
}

async function collectLinkedFiles(
  skillDir: string,
): Promise<Record<string, Array<string>>> {
  const linked: Record<string, Array<string>> = {}

  async function listRel(
    subdir: string,
    patterns: Array<RegExp> | null,
  ): Promise<Array<string>> {
    const dir = path.join(skillDir, subdir)
    const out: Array<string> = []
    async function walk(current: string) {
      let entries: Array<{
        name: string
        isDirectory: () => boolean
        isFile: () => boolean
      }>
      try {
        entries = (await fs.readdir(current, {
          withFileTypes: true,
        })) as unknown as Array<{
          name: string
          isDirectory: () => boolean
          isFile: () => boolean
        }>
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (patterns && !patterns.some((re) => re.test(entry.name))) continue
        out.push(path.relative(skillDir, full).split(path.sep).join('/'))
      }
    }
    await walk(dir)
    return out.sort()
  }

  const references = await listRel('references', [/\.md$/i])
  if (references.length) linked.references = references

  const templates = await listRel('templates', [
    /\.(md|py|ya?ml|json|tex|sh)$/i,
  ])
  if (templates.length) linked.templates = templates

  const assets = await listRel('assets', null)
  if (assets.length) linked.assets = assets

  const scripts = await listRel('scripts', [
    /\.(py|sh|bash|js|ts|rb)$/i,
  ])
  if (scripts.length) linked.scripts = scripts

  return linked
}

export const Route = createFileRoute('/api/skills/content')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const url = new URL(request.url)
          const name = (url.searchParams.get('name') || '').trim()
          const filePath = (url.searchParams.get('file') || '').trim()
          const profile =
            url.searchParams.get('profile')?.trim() ||
            getActiveProfileName() ||
            'default'

          if (!name || !SKILL_NAME_RE.test(name) || /[*?\[\]]/.test(name)) {
            return json(
              { success: false, error: 'A valid skill name is required' },
              { status: 400 },
            )
          }

          const skillsRoot = path.resolve(getSkillsDir(profile))
          const skillDir = await findSkillDir(skillsRoot, name)
          if (!skillDir) {
            return json(
              { success: false, error: `Skill '${name}' not found.` },
              { status: 404 },
            )
          }

          if (filePath) {
            if (
              filePath.includes('\0') ||
              path.isAbsolute(filePath) ||
              filePath.split(/[/\\]/).includes('..')
            ) {
              return json(
                { success: false, error: 'Invalid file path' },
                { status: 400 },
              )
            }
            const target = path.resolve(skillDir, filePath)
            if (!isPathInside(skillDir, target)) {
              return json(
                { success: false, error: 'Invalid file path' },
                { status: 400 },
              )
            }
            try {
              const content = await fs.readFile(target, 'utf-8')
              return json({ content, path: filePath })
            } catch {
              return json(
                { success: false, error: 'File not found' },
                { status: 404 },
              )
            }
          }

          const skillMdPath = path.join(skillDir, 'SKILL.md')
          const content = await fs.readFile(skillMdPath, 'utf-8')
          const linked_files = await collectLinkedFiles(skillDir)

          return json({
            success: true,
            name,
            content,
            path: skillMdPath,
            skill_dir: skillDir,
            linked_files,
          })
        } catch (err) {
          return json(
            {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
