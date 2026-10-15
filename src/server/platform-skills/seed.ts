/**
 * Sync platform catalog from on-disk skills trees (recursive SKILL.md walk,
 * matching Hermes WebUI), then bind each agent to skills found on its own
 * runtime skill roots (+ agents.yaml declarations).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as YAML from 'yaml'
import { loadAgentsRegistry } from '../agent-runtime/agents-config'
import { resolveProfileHermesHome } from '../profiles-browser'
import {
  addAgentSkills,
  listAgentSkillBindings,
  upsertPlatformSkillByName,
} from './store'
import { materializeHermesAgentSkills } from './materialize'
import { scanManySkillsRoots, type ScannedSkill } from './scan-skill-fs'
import {
  allPersonalManagedSkillRoots,
  personalManagedSkillRoots,
  projectManagedSkillRoots,
} from './managed-skill-roots'
import {
  hermesProfileSkillRoots,
  skillRootsForAgentBinding,
} from './agent-skill-roots'

let seedAttempted = false

/** Best-effort one-shot seed; safe to call from API handlers. */
export function ensurePlatformSkillsSeeded(input?: {
  dbPath?: string
  repoRoot?: string
  materialize?: boolean
}): void {
  if (seedAttempted) return
  seedAttempted = true
  try {
    seedPlatformSkillsFromDisk(input)
  } catch (error) {
    console.warn(
      '[platform-skills] seed skipped:',
      error instanceof Error ? error.message : error,
    )
  }
}

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

function skillRootsForHermesProfile(
  profileName: string,
  repoRoot: string,
): Array<string> {
  return [
    path.join(repoRoot, 'skills', 'swarm'),
    path.join(repoRoot, 'skills'),
    ...hermesProfileSkillRoots(profileName),
  ]
}

function collectCatalogRoots(repoRoot: string): Array<string> {
  const registry = loadAgentsRegistry({ repoRoot })
  const hermesRoot = resolveProfileHermesHome('default')
  const roots = new Set<string>([
    path.join(repoRoot, 'skills', 'swarm'),
    path.join(repoRoot, 'skills'),
    path.join(hermesRoot, 'skills'),
    path.join(hermesRoot, 'skills', 'swarm'),
    ...listPluginSkillRoots(hermesRoot),
    ...readExternalSkillsDirs(hermesRoot),
    ...projectManagedSkillRoots(repoRoot),
    ...allPersonalManagedSkillRoots(),
  ])

  const hermesProfilesDir = path.join(hermesRoot, 'profiles')
  try {
    const entries = fs.readdirSync(hermesProfilesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      for (const root of hermesProfileSkillRoots(entry.name)) {
        roots.add(root)
      }
    }
  } catch {
    /* no profiles dir */
  }

  for (const agent of registry.agents) {
    if (agent.runtime === 'hermes') {
      const profile = agent.profile ?? agent.id
      for (const root of skillRootsForHermesProfile(profile, repoRoot)) {
        roots.add(root)
      }
      continue
    }
    for (const root of personalManagedSkillRoots(agent.runtime)) {
      roots.add(root)
    }
  }
  for (const orphan of registry.orphanProfiles) {
    for (const root of skillRootsForHermesProfile(orphan, repoRoot)) {
      roots.add(root)
    }
  }
  return [...roots]
}

function upsertScanned(
  skill: ScannedSkill,
  dbOpts?: { dbPath?: string },
): { created: boolean; id: string } {
  const { skill: row, created } = upsertPlatformSkillByName(
    {
      name: skill.name,
      description: skill.description,
      category: skill.category,
      content: skill.content,
      files: skill.files,
      origin: {
        kind: 'profile_fs',
        source: skill.sourceDir,
        importedAt: Date.now(),
      },
    },
    dbOpts,
  )
  return { created, id: row.id }
}

export type SeedResult = {
  skillsUpserted: number
  skillsScanned: number
  bindingsAdded: number
  materialized: Array<string>
}

/** @deprecated Use seedPlatformSkillsFromDisk — kept for call-site compatibility. */
export function seedPlatformSkillsFromAgentsYaml(input?: {
  repoRoot?: string
  dbPath?: string
  materialize?: boolean
}): SeedResult {
  return seedPlatformSkillsFromDisk(input)
}

export function seedPlatformSkillsFromDisk(input?: {
  repoRoot?: string
  dbPath?: string
  materialize?: boolean
}): SeedResult {
  const repoRoot = input?.repoRoot ?? process.cwd()
  const registry = loadAgentsRegistry({ repoRoot })
  const dbOpts = input?.dbPath ? { dbPath: input.dbPath } : undefined

  const scanned = scanManySkillsRoots(collectCatalogRoots(repoRoot), {
    skipPlatformManaged: true,
  })

  let skillsUpserted = 0
  const nameToId = new Map<string, string>()
  for (const skill of scanned) {
    const { created, id } = upsertScanned(skill, dbOpts)
    if (created) skillsUpserted += 1
    nameToId.set(skill.name.toLowerCase(), id)
  }

  let bindingsAdded = 0
  const hermesAgents = new Set<string>()

  type BindTarget = {
    id: string
    runtime: string
    profile?: string
    skills?: Array<string>
  }
  const bindTargets: Array<BindTarget> = registry.agents.map((agent) => ({
    id: agent.id,
    runtime: agent.runtime,
    profile: agent.profile,
    skills: agent.skills,
  }))
  // Orphan Hermes profiles (especially `default` at ~/.hermes, not
  // ~/.hermes/profiles/default) appear in /api/agents but are not in
  // agents.yaml — still auto-bind their on-disk skills.
  const boundIds = new Set(bindTargets.map((t) => t.id))
  for (const orphan of registry.orphanProfiles) {
    if (boundIds.has(orphan)) continue
    bindTargets.push({
      id: orphan,
      runtime: 'hermes',
      profile: orphan,
      skills: [],
    })
  }

  for (const agent of bindTargets) {
    const before = listAgentSkillBindings(agent.id, dbOpts).length
    const skillIds = new Set<string>()

    // 1) Bind skills already present on this agent's local roots.
    //    hermes + profile `default` → resolveProfileHermesHome → ~/.hermes/skills
    const localRoots = skillRootsForAgentBinding({
      agentId: agent.id,
      runtime: agent.runtime,
      profile: agent.profile,
      repoRoot,
    })
    const localSkills = scanManySkillsRoots(localRoots, {
      // Include platform-managed trees so re-sync still re-binds them.
      skipPlatformManaged: false,
    })
    for (const skill of localSkills) {
      let skillId = nameToId.get(skill.name.toLowerCase())
      if (!skillId) {
        const upserted = upsertScanned(skill, dbOpts)
        if (upserted.created) skillsUpserted += 1
        skillId = upserted.id
        nameToId.set(skill.name.toLowerCase(), skillId)
      }
      skillIds.add(skillId)
    }

    // 2) agents.yaml declared skills (stub if missing on disk).
    for (const rawName of agent.skills ?? []) {
      const name = String(rawName || '').trim()
      if (!name) continue
      let skillId = nameToId.get(name.toLowerCase())
      if (!skillId) {
        const { skill } = upsertPlatformSkillByName(
          {
            name,
            description: '',
            category: 'General',
            content: `# ${name}\n\nSeeded from agents.yaml (content pending import).\n`,
            origin: {
              kind: 'agents_yaml',
              source: `agents.yaml:${agent.id}`,
              importedAt: Date.now(),
            },
          },
          dbOpts,
        )
        skillId = skill.id
        nameToId.set(name.toLowerCase(), skillId)
        skillsUpserted += 1
      }
      skillIds.add(skillId)
    }

    if (skillIds.size > 0) {
      addAgentSkills(agent.id, [...skillIds], dbOpts)
    }
    const after = listAgentSkillBindings(agent.id, dbOpts).length
    bindingsAdded += Math.max(0, after - before)

    if (agent.runtime === 'hermes') hermesAgents.add(agent.id)
  }

  const materialized: Array<string> = []
  if (input?.materialize !== false) {
    for (const agentId of hermesAgents) {
      materializeHermesAgentSkills(agentId)
      materialized.push(agentId)
    }
  }

  return {
    skillsUpserted,
    skillsScanned: scanned.length,
    bindingsAdded,
    materialized,
  }
}
