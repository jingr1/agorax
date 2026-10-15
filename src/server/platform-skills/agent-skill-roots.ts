/**
 * Resolve on-disk skill roots that belong to a specific agent.
 * Used by seed (auto-bind) and "从 Agent 已有的 skill 复制".
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as YAML from 'yaml'
import type { AgentRuntimeKind } from '../agent-runtime/types'
import { resolveProfileHermesHome } from '../profiles-browser'
import {
  personalManagedSkillRoots,
  projectManagedSkillRoots,
} from './managed-skill-roots'

function readExternalSkillsDirs(hermesHome: string): Array<string> {
  const configPath = path.join(hermesHome, 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw) as Record<string, unknown> | null
    const skills = parsed?.skills as Record<string, unknown> | undefined
    const external = skills?.external_dirs
    const list = Array.isArray(external)
      ? external
      : typeof external === 'string'
        ? [external]
        : []
    const out: Array<string> = []
    for (const entry of list) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      let expanded = entry.trim().replace(/^~(?=\/|$)/, process.env.HOME || '')
      if (!path.isAbsolute(expanded)) {
        expanded = path.join(hermesHome, expanded)
      }
      if (fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
        out.push(expanded)
      }
    }
    return out
  } catch {
    return []
  }
}

function listPluginSkillRoots(hermesHome: string): Array<string> {
  const pluginsRoot = path.join(hermesHome, 'plugins')
  const out: Array<string> = []
  let entries: Array<fs.Dirent>
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillsDir = path.join(pluginsRoot, entry.name, 'skills')
    if (fs.existsSync(skillsDir)) out.push(skillsDir)
  }
  return out
}

/** Hermes profile-local roots only (not shared repo catalog dumps). */
export function hermesProfileSkillRoots(profileName: string): Array<string> {
  const hermesHome = resolveProfileHermesHome(profileName)
  return [
    path.join(hermesHome, 'skills'),
    path.join(hermesHome, 'skills', 'swarm'),
    ...listPluginSkillRoots(hermesHome),
    ...readExternalSkillsDirs(hermesHome),
  ]
}

/**
 * Roots to scan when binding "this agent's installed skills".
 *
 * Hermes uses `resolveProfileHermesHome`:
 * - `default` → `~/.hermes/skills` (not `~/.hermes/profiles/default`)
 * - named profile → `~/.hermes/profiles/<name>/skills`
 *
 * Shared repo `skills/` dumps stay catalog-only unless they also appear under
 * an agent's own Hermes home.
 */
export function skillRootsForAgentBinding(input: {
  agentId: string
  runtime: AgentRuntimeKind | string
  profile?: string
  repoRoot?: string
}): Array<string> {
  const runtime = input.runtime
  if (runtime === 'hermes') {
    // Prefer explicit profile; for orphan `default` agentId === 'default'.
    return hermesProfileSkillRoots(input.profile ?? input.agentId)
  }
  const roots = [...personalManagedSkillRoots(runtime)]
  if (input.repoRoot) {
    roots.push(...projectManagedSkillRoots(input.repoRoot))
  }
  return roots
}
