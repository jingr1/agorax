/**
 * Materialize enabled platform skill bindings into a Hermes profile's skills/
 * directory so the existing Hermes runtime / slash skill loader keeps working.
 *
 * Only touches directories marked with `.agorax-platform-skill`. User/synced
 * swarm skills without the marker are left alone.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  resolveProfileHermesHome,
  updateProfileConfig,
  readProfile,
} from '../profiles-browser'
import {
  getPlatformSkill,
  listAgentSkillBindings,
} from './store'

const PLATFORM_MARKER = '.agorax-platform-skill'

function safeSkillDirName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function writeSkillTree(
  destRoot: string,
  skill: {
    name: string
    content: string
    files?: Array<{ path: string; content: string }>
  },
): 'written' | 'skipped-existing' {
  const dir = path.join(destRoot, safeSkillDirName(skill.name))
  const markerPath = path.join(dir, PLATFORM_MARKER)
  // Never clobber a user/synced skill tree that Hermes already loads.
  // Only create or refresh dirs we previously materialized.
  if (fs.existsSync(dir) && !fs.existsSync(markerPath)) {
    return 'skipped-existing'
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.content || '', 'utf-8')
  fs.writeFileSync(markerPath, '1\n', 'utf-8')
  for (const file of skill.files ?? []) {
    const rel = file.path.replace(/^\/+/, '')
    if (!rel || rel.includes('..') || rel === 'SKILL.md') continue
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, file.content ?? '', 'utf-8')
  }
  return 'written'
}

function removeStalePlatformSkills(
  skillsRoot: string,
  keepNames: Set<string>,
): void {
  if (!fs.existsSync(skillsRoot)) return
  let entries: Array<fs.Dirent>
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(skillsRoot, entry.name)
    if (!fs.existsSync(path.join(dir, PLATFORM_MARKER))) continue
    if (keepNames.has(entry.name)) continue
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Rewrite profile skills.disabled for platform-managed names:
 * strip managed names from disabled, then add currently disabled bindings.
 */
function rewritePlatformDisabled(
  profileName: string,
  managedNames: Array<string>,
  disabledNames: Array<string>,
): void {
  try {
    const detail = readProfile(profileName)
    const managed = new Set(managedNames)
    const currentDisabled: Array<string> = Array.isArray(
      (detail.config as { skills?: { disabled?: Array<string> } })?.skills
        ?.disabled,
    )
      ? [
          ...((
            detail.config as { skills: { disabled: Array<string> } }
          ).skills.disabled ?? []),
        ]
      : []
    const unique = [
      ...new Set([
        ...currentDisabled.filter((name) => !managed.has(name)),
        ...disabledNames,
      ]),
    ]
    updateProfileConfig(profileName, {
      skills: { disabled: unique },
    })
  } catch {
    /* profile missing — skip */
  }
}

export function materializeHermesAgentSkills(agentId: string): {
  runtime: string
  profile?: string
  written: Array<string>
} {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  const isHermes =
    decl?.runtime === 'hermes' ||
    (!decl && router.registry.orphanProfiles.includes(agentId))
  if (!isHermes) {
    return { runtime: decl?.runtime ?? 'unknown', written: [] }
  }
  const profileName = decl?.profile ?? agentId
  const hermesHome = resolveProfileHermesHome(profileName)
  const skillsRoot = path.join(hermesHome, 'skills')
  fs.mkdirSync(skillsRoot, { recursive: true })

  const bindings = listAgentSkillBindings(agentId)
  const managedNames = bindings.map((b) => safeSkillDirName(b.name))
  const disabledNames = bindings
    .filter((b) => !b.enabled)
    .map((b) => safeSkillDirName(b.name))
  const written: Array<string> = []

  for (const binding of bindings) {
    const skill = getPlatformSkill(binding.skillId, { includeFiles: true })
    if (!skill) continue
    const result = writeSkillTree(skillsRoot, skill)
    if (result === 'written' && binding.enabled) {
      written.push(safeSkillDirName(skill.name))
    }
  }

  removeStalePlatformSkills(skillsRoot, new Set(managedNames))
  rewritePlatformDisabled(profileName, managedNames, disabledNames)

  return {
    runtime: 'hermes',
    profile: profileName,
    written,
  }
}
