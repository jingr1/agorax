/**
 * Skill usage from Hermes profile `skills/.usage.json` (written by agent).
 * Local control plane — no Dashboard :9119 required.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DashboardSkillsUsageSection } from './dashboard-aggregator'
import { getProfilesRoot } from './profiles-browser'

const USAGE_FILE = '.usage.json'

type UsageEntry = {
  use_count: number
  view_count: number
  patch_count: number
  last_used_at: string | null
  last_viewed_at: string | null
  last_patched_at: string | null
}

function hermesRoot(): string {
  return process.env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes')
}

function listSkillsUsageFiles(): Array<string> {
  const out: Array<string> = []
  const rootSkills = path.join(hermesRoot(), 'skills', USAGE_FILE)
  if (fs.existsSync(rootSkills)) out.push(rootSkills)

  const profilesRoot = getProfilesRoot()
  if (!fs.existsSync(profilesRoot)) return out

  for (const name of fs.readdirSync(profilesRoot)) {
    if (name.startsWith('.')) continue
    const filePath = path.join(profilesRoot, name, 'skills', USAGE_FILE)
    if (fs.existsSync(filePath)) out.push(filePath)
  }
  return out
}

function readUsageFile(filePath: string): Record<string, UsageEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >
    const out: Record<string, UsageEntry> = {}
    for (const [skill, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      out[skill] = {
        use_count: readInt(v.use_count),
        view_count: readInt(v.view_count),
        patch_count: readInt(v.patch_count),
        last_used_at: readIso(v.last_used_at),
        last_viewed_at: readIso(v.last_viewed_at),
        last_patched_at: readIso(v.last_patched_at),
      }
    }
    return out
  } catch {
    return {}
  }
}

function readInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function readIso(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseIsoMs(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function lastActivityMs(entry: UsageEntry): number | null {
  return (
    parseIsoMs(entry.last_used_at) ??
    parseIsoMs(entry.last_viewed_at) ??
    parseIsoMs(entry.last_patched_at)
  )
}

function mergeUsageMaps(
  maps: Array<Record<string, UsageEntry>>,
): Map<string, UsageEntry> {
  const merged = new Map<string, UsageEntry>()
  for (const map of maps) {
    for (const [skill, entry] of Object.entries(map)) {
      const prev = merged.get(skill)
      if (!prev) {
        merged.set(skill, { ...entry })
        continue
      }
      merged.set(skill, {
        use_count: prev.use_count + entry.use_count,
        view_count: prev.view_count + entry.view_count,
        patch_count: prev.patch_count + entry.patch_count,
        last_used_at: pickLatestIso(prev.last_used_at, entry.last_used_at),
        last_viewed_at: pickLatestIso(prev.last_viewed_at, entry.last_viewed_at),
        last_patched_at: pickLatestIso(
          prev.last_patched_at,
          entry.last_patched_at,
        ),
      })
    }
  }
  return merged
}

function pickLatestIso(a: string | null, b: string | null): string | null {
  const ams = parseIsoMs(a)
  const bms = parseIsoMs(b)
  if (ams === null) return b
  if (bms === null) return a
  return bms >= ams ? b : a
}

/**
 * Aggregate skill usage across default + all profiles.
 *
 * `.usage.json` stores lifetime counters (agent does not shard by window),
 * so we do not filter by `windowDays` here.
 */
export function readLocalSkillsUsage(
  _windowDays: number,
): DashboardSkillsUsageSection | null {
  const files = listSkillsUsageFiles()
  if (files.length === 0) return null

  const merged = mergeUsageMaps(files.map(readUsageFile))
  if (merged.size === 0) return null

  let totalLoads = 0
  let totalEdits = 0
  let totalActions = 0
  const rows: Array<{
    skill: string
    totalCount: number
    lastUsedAt: number | null
  }> = []

  for (const [skill, entry] of merged) {
    const uses = entry.use_count
    const views = entry.view_count
    const patches = entry.patch_count
    const actions = uses + views + patches
    if (actions <= 0) continue

    totalLoads += views
    totalEdits += patches
    totalActions += actions

    const lastMs = lastActivityMs(entry)
    rows.push({
      skill,
      totalCount: actions,
      lastUsedAt: lastMs !== null ? Math.floor(lastMs / 1000) : null,
    })
  }

  if (rows.length === 0) return null

  rows.sort((a, b) => b.totalCount - a.totalCount)
  const topSkills = rows.slice(0, 5).map((row) => ({
    ...row,
    percentage:
      totalActions > 0
        ? Math.round((row.totalCount / totalActions) * 1000) / 10
        : 0,
  }))

  return {
    totalLoads,
    totalEdits,
    totalActions,
    distinctSkills: rows.length,
    topSkills,
  }
}
