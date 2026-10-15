/**
 * Aggregated capabilities endpoint for a single profile.
 *
 *   GET /api/profiles/capabilities?name=<profile>
 *     → returns { skills, mcpServers, toolsets, workspace, envExists }
 *
 * This reduces frontend request count — one fetch instead of three
 * (skills + MCP + config read). Reads from the local filesystem
 * (profiles-browser) and optionally proxies to the dashboard for
 * per-profile skills when available.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { readProfile, getProfilesRoot } from '../../../server/profiles-browser'
import {
  normalizeMcpListFromConfig,
  maskSecretsInPlace,
} from '../../../server/mcp-normalize'
import {
  dashboardFetch,
  ensureGatewayEnhancedProbed,
} from '../../../server/gateway-capabilities'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

type SkillItem = {
  name: string
  description?: string
  category?: string | null
  enabled: boolean
  path?: string
}

function readEnabledToolsets(config: Record<string, unknown>): string[] {
  const toolsets = config.toolsets
  if (!Array.isArray(toolsets)) return []
  return toolsets.filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  )
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
  const skillsDir = path.join(profilePath, 'skills')
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
    const catPath = path.join(skillsDir, cat.name)
    let skillEntries: Array<fs.Dirent> = []
    try {
      skillEntries = fs.readdirSync(catPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const skill of skillEntries) {
      if (!skill.isDirectory() && !skill.isSymbolicLink()) continue
      if (skill.name.startsWith('.')) continue
      const skillPath = path.join(catPath, skill.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      let description = ''
      try {
        const raw = fs.readFileSync(skillMdPath, 'utf-8')
        // Extract frontmatter description
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

  // Also check flat skills dir (no category subdirs)
  const flatEntries: Array<fs.Dirent> = []
  try {
    flatEntries.push(...fs.readdirSync(skillsDir, { withFileTypes: true }))
  } catch {
    // ignore
  }
  for (const entry of flatEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    // Skip if this is already a category dir (has subdirs)
    const entryPath = path.join(skillsDir, entry.name)
    const hasSkillMd = fs.existsSync(path.join(entryPath, 'SKILL.md'))
    if (hasSkillMd && !results.some((r) => r.name === entry.name)) {
      let description = ''
      try {
        const raw = fs.readFileSync(path.join(entryPath, 'SKILL.md'), 'utf-8')
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
        name: entry.name,
        description,
        category: null,
        enabled: !disabledSet.has(entry.name),
        path: entryPath,
      })
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

async function fetchDashboardSkills(
  profile: string,
): Promise<SkillItem[] | null> {
  const capabilities = await ensureGatewayEnhancedProbed()
  if (!capabilities.skills || !capabilities.dashboard.available) {
    return null
  }
  try {
    const response = await dashboardFetch(
      `/api/profiles/${encodeURIComponent(profile)}/skills`,
      { signal: AbortSignal.timeout(15_000) },
    )
    if (!response.ok) return null
    const body = await response.text()
    const parsed = JSON.parse(body)
    const items = Array.isArray(parsed) ? parsed : []
    return items.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ''),
      description: String(item.description ?? ''),
      category: typeof item.category === 'string' ? item.category : null,
      enabled: item.enabled !== false,
      path: typeof item.path === 'string' ? item.path : undefined,
    }))
  } catch {
    return null
  }
}

export const Route = createFileRoute('/api/profiles/capabilities')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const name = (url.searchParams.get('name') || '').trim()
          if (!name || !PROFILE_NAME_RE.test(name)) {
            return json(
              { error: 'A valid profile name is required' },
              { status: 400 },
            )
          }

          const profile = readProfile(name)
          const config = profile.config
          const mcpServers = normalizeMcpListFromConfig(config)
          for (const s of mcpServers) maskSecretsInPlace(s)
          const toolsets = readEnabledToolsets(config)
          const disabledSet = getSkillsDisabledSet(config)

          // Control-plane refactor: always read skills from local filesystem
          const skills = listLocalSkills(profile.path, disabledSet)

          return json({
            profile: name,
            skills,
            mcpServers: mcpServers.map((s) => ({
              name: s.name,
              enabled: s.enabled,
              status: s.status,
              transportType: s.transportType,
              url: s.url,
              command: s.command,
              error: s.lastError,
            })),
            toolsets,
            workspace: profile.path,
            envExists: profile.hasEnv,
            envPath: profile.envPath,
            // Include configured model so the detail panel dropdown can pre-populate
            // without needing a separate /api/models call.
            defaultModel: (config as Record<string, unknown>).model
              ? String((config as Record<string, unknown>).model)
              : null,
          })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to read profile capabilities',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
