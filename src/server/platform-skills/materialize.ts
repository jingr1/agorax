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
  readProfile,
  resolveProfileHermesHome,
  updateProfileConfig,
} from '../profiles-browser'
import { listAgentSkillBindings } from './store'
import { reconcilePlatformSkill } from './reconcile'
import { hashSkillTree, readSkillMarker, readSkillTree } from './skill-tree'
import { removeSkillDeployment } from './deployment-tree'
import { platformSkillTarget } from './runtime-target'
import type { SkillDeploymentResult } from './reconcile'

const PLATFORM_MARKER = '.agorax-platform-skill'

function safeSkillDirName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
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
    if (
      (!entry.isDirectory() && !entry.isSymbolicLink()) ||
      entry.name.startsWith('.') ||
      entry.name.includes('.agorax-')
    )
      continue
    const dir = path.join(skillsRoot, entry.name)
    if (!fs.existsSync(path.join(dir, PLATFORM_MARKER))) continue
    if (keepNames.has(entry.name)) continue
    const marker = readSkillMarker(dir)
    if (!marker) continue
    if (entry.isSymbolicLink()) {
      removeSkillDeployment(dir, marker.skillId)
      continue
    }
    if (hashSkillTree(readSkillTree(dir)) === marker.baseHash) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
): string | undefined {
  try {
    const detail = readProfile(profileName)
    const managed = new Set(managedNames)
    const currentDisabled: Array<string> = Array.isArray(
      (detail.config as { skills?: { disabled?: Array<string> } }).skills
        ?.disabled,
    )
      ? [
          ...(detail.config as { skills: { disabled: Array<string> } }).skills
            .disabled,
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
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function materializeHermesAgentSkills(agentId: string): {
  runtime: string
  profile?: string
  written: Array<string>
  deployments: Array<SkillDeploymentResult>
} {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  const isHermes =
    decl?.runtime === 'hermes' ||
    (!decl && router.registry.orphanProfiles.includes(agentId))
  if (!isHermes) {
    const bindings = listAgentSkillBindings(agentId)
    const deployments = bindings.flatMap((binding) => reconcilePlatformSkill(binding.skillId))
    const target = platformSkillTarget(agentId)
    if (target.root) removeStalePlatformSkills(target.root, new Set(bindings.map((binding) => safeSkillDirName(binding.name))))
    return {
      runtime: decl?.runtime ?? 'unknown',
      written: [],
      deployments,
    }
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
  const deployments: Array<SkillDeploymentResult> = []

  for (const binding of bindings) {
    const results = reconcilePlatformSkill(binding.skillId)
    deployments.push(...results)
    if (
      results.some(
        (result) => result.agentId === agentId && result.status === 'in-sync',
      ) &&
      binding.enabled
    ) {
      written.push(safeSkillDirName(binding.name))
    }
  }

  removeStalePlatformSkills(skillsRoot, new Set(managedNames))
  const configError = rewritePlatformDisabled(
    profileName,
    managedNames,
    disabledNames,
  )
  if (configError)
    deployments.push({
      agentId,
      skillId: '',
      name: '',
      status: 'error',
      message: `Profile configuration update failed: ${configError}`,
    })

  return {
    runtime: 'hermes',
    profile: profileName,
    written,
    deployments,
  }
}
