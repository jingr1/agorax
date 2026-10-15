/**
 * List / promote skills already installed on an agent's local runtime FS
 * into the platform catalog ("从 Agent 已有的 skill 复制").
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  createPlatformSkill,
  getPlatformSkill,
} from './store'
import { scanManySkillsRoots } from './scan-skill-fs'
import { skillRootsForAgentBinding } from './agent-skill-roots'
import type { PlatformSkill } from './types'

const PLATFORM_MARKER = '.agorax-platform-skill'

export type AgentLocalSkillSummary = {
  name: string
  description: string
  category: string
  path: string
  platformManaged: boolean
  alreadyInCatalog: boolean
  catalogSkillId?: string
}

function skillRootsForAgent(agentId: string): {
  runtime: string
  roots: Array<string>
} {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)

  if (
    decl?.runtime === 'hermes' ||
    (!decl && router.registry.orphanProfiles.includes(agentId))
  ) {
    return {
      runtime: 'hermes',
      roots: skillRootsForAgentBinding({
        agentId,
        runtime: 'hermes',
        profile: decl?.profile ?? agentId,
      }),
    }
  }

  const runtime = decl?.runtime ?? 'unknown'
  return {
    runtime,
    roots: skillRootsForAgentBinding({
      agentId,
      runtime,
      repoRoot: process.cwd(),
    }),
  }
}

function isPlatformManaged(sourceDir: string): boolean {
  return fs.existsSync(path.join(sourceDir, PLATFORM_MARKER))
}

export function listAgentLocalSkills(agentId: string): {
  agentId: string
  runtime: string
  skills: Array<AgentLocalSkillSummary>
} {
  const { runtime, roots } = skillRootsForAgent(agentId)
  const local = scanManySkillsRoots(roots, { skipPlatformManaged: false })
  const skills: Array<AgentLocalSkillSummary> = local.map((item) => {
    const existing = getPlatformSkill(item.name)
    return {
      name: item.name,
      description: item.description,
      category: item.category,
      path: item.sourceDir,
      platformManaged: isPlatformManaged(item.sourceDir),
      alreadyInCatalog: Boolean(existing),
      catalogSkillId: existing?.id,
    }
  })
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { agentId, runtime, skills }
}

export function promoteAgentLocalSkills(
  agentId: string,
  skillNames: Array<string>,
): {
  created: Array<PlatformSkill>
  skipped: Array<{ name: string; reason: string }>
} {
  const wanted = new Set(
    skillNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
  )
  if (wanted.size === 0) {
    throw new Error('skillNames is required')
  }
  const { roots } = skillRootsForAgent(agentId)
  const local = scanManySkillsRoots(roots, { skipPlatformManaged: false })
  const created: Array<PlatformSkill> = []
  const skipped: Array<{ name: string; reason: string }> = []

  for (const name of wanted) {
    const match = local.find((s) => s.name.toLowerCase() === name)
    if (!match) {
      skipped.push({ name, reason: 'not found on agent filesystem' })
      continue
    }
    if (isPlatformManaged(match.sourceDir)) {
      skipped.push({
        name: match.name,
        reason: 'already a platform-managed skill on this agent',
      })
      continue
    }
    const existing = getPlatformSkill(match.name)
    if (existing) {
      skipped.push({ name: match.name, reason: 'already in catalog' })
      continue
    }
    try {
      const skill = createPlatformSkill({
        name: match.name,
        description: match.description,
        category: match.category,
        content: match.content,
        files: match.files,
        origin: {
          kind: 'profile_fs',
          source: `agent:${agentId}:${match.sourceDir}`,
          importedAt: Date.now(),
        },
      })
      created.push(skill)
    } catch (error) {
      skipped.push({
        name: match.name,
        reason: error instanceof Error ? error.message : 'import failed',
      })
    }
  }

  return { created, skipped }
}
