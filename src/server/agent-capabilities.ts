/**
 * Per-agent capabilities for Agents / Operations UI.
 *
 * Hermes: profile FS (config.yaml mcp_servers, skills/, toolsets, model).
 * Managed: platform bindings + runtime settings (Claude/Codex model/provider).
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { getAgentRuntimeRouter } from './agent-runtime/router'
import type { AgentRuntimeKind } from './agent-runtime/types'
import {
  readClaudeCodeSettings,
  resolveClaudeCodeCurrentModel,
  resolveClaudeCodeProvider,
} from './claude-code-settings'
import {
  readCodexConfig,
  resolveCodexProviderDisplay,
} from './codex-settings'
import {
  normalizeMcpListFromConfig,
  maskSecretsInPlace,
} from './mcp-normalize'
import { listAgentMcpBindings } from './platform-mcp'
import { listAgentSkillBindings } from './platform-skills'
import { personalManagedSkillRoots } from './platform-skills/managed-skill-roots'
import { readProfile } from './profiles-browser'

export type AgentCapabilitySkill = {
  name: string
  skillId?: string
  description?: string
  category?: string | null
  enabled: boolean
  path?: string
  source?: 'platform' | 'profile'
}

export type AgentCapabilityMcp = {
  name: string
  enabled: boolean
  status?: string
  transportType?: string
  url?: string
  command?: string
  error?: string
  serverId?: string
  source?: 'platform' | 'profile'
}

export type AgentCapabilities = {
  agentId: string
  runtime: AgentRuntimeKind | 'unknown'
  skills: Array<AgentCapabilitySkill>
  mcpServers: Array<AgentCapabilityMcp>
  toolsets: Array<string>
  workspace?: string
  envExists: boolean
  envPath?: string
  defaultModel: string | null
  provider: string | null
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

function listLocalHermesSkills(
  profilePath: string,
  disabledSet: Set<string>,
): Array<AgentCapabilitySkill> {
  const skillsDir = path.join(profilePath, 'skills')
  const results: Array<AgentCapabilitySkill> = []
  if (!fs.existsSync(skillsDir)) return results

  let entries: Array<fs.Dirent> = []
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const cat of entries) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue
    const catPath = path.join(skillsDir, cat.name)
    const skillMdAtCat = path.join(catPath, 'SKILL.md')
    if (fs.existsSync(skillMdAtCat)) {
      results.push({
        name: cat.name,
        description: readSkillDescription(skillMdAtCat),
        category: null,
        enabled: !disabledSet.has(cat.name),
        path: catPath,
        source: 'profile',
      })
      continue
    }
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
      results.push({
        name: skill.name,
        description: readSkillDescription(skillMdPath),
        category: cat.name,
        enabled: !disabledSet.has(skill.name),
        path: skillPath,
        source: 'profile',
      })
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

function readSkillDescription(skillMdPath: string): string {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf-8')
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) return ''
    const descMatch = fmMatch[1].match(/^description:\s*(.+?)\s*$/m)
    if (!descMatch) return ''
    return descMatch[1].replace(/^["']|["']$/g, '')
  } catch {
    return ''
  }
}

function readManagedModelProvider(runtime: string): {
  model: string
  provider: string
} {
  switch (runtime) {
    case 'claude-code': {
      const settings = readClaudeCodeSettings()
      return {
        model: resolveClaudeCodeCurrentModel(settings),
        provider: resolveClaudeCodeProvider(settings),
      }
    }
    case 'codex': {
      const cfg = readCodexConfig()
      return {
        model: cfg.model,
        provider: resolveCodexProviderDisplay(cfg),
      }
    }
    default:
      return { model: '', provider: '' }
  }
}

function managedWorkspace(runtime: string): string | undefined {
  switch (runtime) {
    case 'claude-code':
      return path.join(homedir(), '.claude')
    case 'codex':
      return path.join(homedir(), '.codex')
    case 'cursor':
      return path.join(homedir(), '.cursor')
    case 'opencode':
      return path.join(homedir(), '.config', 'opencode')
    case 'kimi':
      return path.join(homedir(), '.kimi')
    case 'deepseek-harness':
      return path.join(homedir(), '.agents')
    default: {
      const roots = personalManagedSkillRoots(runtime)
      return roots[0] ? path.dirname(roots[0]) : undefined
    }
  }
}

function agentExists(agentId: string): boolean {
  const router = getAgentRuntimeRouter()
  return (
    router.registry.byId.has(agentId) ||
    router.registry.orphanProfiles.includes(agentId)
  )
}

function resolveRuntime(agentId: string): {
  runtime: AgentRuntimeKind | 'unknown'
  isHermes: boolean
  profileName: string
} {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (decl) {
    const isHermes = decl.runtime === 'hermes'
    return {
      runtime: decl.runtime,
      isHermes,
      profileName: decl.profile ?? agentId,
    }
  }
  if (router.registry.orphanProfiles.includes(agentId) || agentId === 'default') {
    return { runtime: 'hermes', isHermes: true, profileName: agentId }
  }
  return { runtime: 'unknown', isHermes: false, profileName: agentId }
}

/**
 * Build capabilities for a registry agent (Hermes or managed).
 * Throws if the agent id is unknown.
 */
export function buildAgentCapabilities(agentId: string): AgentCapabilities {
  const id = agentId.trim()
  if (!id) throw new Error('agentId is required')
  if (!agentExists(id) && id !== 'default') {
    throw new Error(`Unknown agent: ${id}`)
  }

  const { runtime, isHermes, profileName } = resolveRuntime(id)
  const platformSkills = listAgentSkillBindings(id).map((s) => ({
    name: s.name,
    skillId: s.skillId,
    description: s.description,
    enabled: s.enabled,
    source: 'platform' as const,
  }))
  const platformMcp = listAgentMcpBindings(id).map((s) => ({
    name: s.name,
    enabled: s.enabled,
    status: s.enabled ? 'ok' : 'disabled',
    transportType: s.transport,
    serverId: s.serverId,
    source: 'platform' as const,
  }))

  if (!isHermes) {
    const external = readManagedModelProvider(runtime)
    return {
      agentId: id,
      runtime,
      skills: platformSkills,
      mcpServers: platformMcp,
      toolsets: [],
      workspace: managedWorkspace(runtime),
      envExists: Boolean(external.model || external.provider),
      defaultModel: external.model || null,
      provider: external.provider || null,
    }
  }

  const profile = readProfile(profileName)
  const config = profile.config
  const mcpServers = normalizeMcpListFromConfig(config)
  for (const s of mcpServers) maskSecretsInPlace(s)
  const toolsets = readEnabledToolsets(config)
  const disabledSet = getSkillsDisabledSet(config)
  const profileSkills = listLocalHermesSkills(profile.path, disabledSet)

  const platformNames = new Set(
    platformSkills.map((s) => s.name.toLowerCase()),
  )
  const profileOnlySkills = profileSkills.filter(
    (s) => !platformNames.has(s.name.toLowerCase()),
  )
  const platformMcpNames = new Set(
    platformMcp.map((m) => m.name.toLowerCase()),
  )
  const profileOnlyMcp = mcpServers
    .filter((m) => !platformMcpNames.has(m.name.toLowerCase()))
    .map((s) => ({
      name: s.name,
      enabled: s.enabled,
      status: s.status,
      transportType: s.transportType,
      url: s.url,
      command: s.command,
      error: s.lastError,
      source: 'profile' as const,
    }))

  const modelRaw = (config as Record<string, unknown>).model
  const defaultModel =
    typeof modelRaw === 'string'
      ? modelRaw
      : modelRaw && typeof modelRaw === 'object'
        ? String(
            (modelRaw as Record<string, unknown>).default ??
              (modelRaw as Record<string, unknown>).name ??
              '',
          ) || null
        : null
  const providerRaw =
    modelRaw && typeof modelRaw === 'object'
      ? (modelRaw as Record<string, unknown>).provider
      : undefined

  return {
    agentId: id,
    runtime: 'hermes',
    skills: [...platformSkills, ...profileOnlySkills],
    mcpServers: [...platformMcp, ...profileOnlyMcp],
    toolsets,
    workspace: profile.path,
    envExists: profile.hasEnv,
    envPath: profile.envPath,
    defaultModel: defaultModel && defaultModel.trim() ? defaultModel : null,
    provider: typeof providerRaw === 'string' ? providerRaw : null,
  }
}
