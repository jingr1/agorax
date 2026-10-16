/**
 * agents.yaml loader — runtime declarations for Hermes + managed agents.
 *
 * Local agents.yaml (gitignored) is the runtime source of truth, seeded from
 * agents.yaml.example on install / first load. UI writes agents.yaml directly.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import * as YAML from 'yaml'
import type { AgentRuntimeKind } from './types'
import { AGORAX_MANAGED_AGENT_BACKENDS } from '@/lib/managed-agent-runtime/agent-targets'
import { ensureAgentsYamlFromExample } from '../swarm-roster'

export type AgentExecution = 'local' | 'ssh'

export type AgentDeclaration = {
  id: string
  name?: string
  role?: string
  specialty?: string
  mission?: string
  runtime: AgentRuntimeKind
  /** Hermes profile name (runtime: hermes). */
  profile?: string
  /** Install/chat ensure materializes ~/.hermes/profiles/<id> when true. */
  ensureProfile?: boolean
  /** CLI command (non-hermes runtimes). */
  command?: string
  args?: Array<string>
  modes: Array<string>
  tools: Array<string>
  skills: Array<string>
  plugins: Array<string>
  pluginToolsets: Array<string>
  mcpServers: Array<string>
  wrapper?: string
  preferredTaskTypes: Array<string>
  greenlightRequiredFor: Array<string>
  acceptsBroadcast: boolean
  reviewRequired: boolean
  dispatchable: boolean
  /** Optional model override for CLI-based runtimes. */
  model?: string
  execution: AgentExecution
  capabilities: Array<string>
  maxConcurrentTasks?: number
  mentionName?: string
  displayName?: string
}

export type AgentsRegistry = {
  version: number
  agents: Array<AgentDeclaration>
  /** Ids present in agents.yaml. */
  byId: Map<string, AgentDeclaration>
  /** Orphan hermes profiles discovered on disk but not declared. */
  orphanProfiles: Array<string>
}

const RUNTIMES: ReadonlyArray<AgentRuntimeKind> = [
  'hermes',
  'deepseek-harness',
  ...AGORAX_MANAGED_AGENT_BACKENDS,
]

export function getAgentsYamlPath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), 'agents.yaml')
}

export function getAgentsYamlExamplePath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), 'agents.yaml.example')
}

/** Read a hermes profile's terminal.ssh_host (P2b ssh locality). */
export function getProfileSshHost(profileId: string): string | null {
  const configPath = path.join(
    homedir(),
    '.hermes',
    'profiles',
    profileId,
    'config.yaml',
  )
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw) as Record<string, unknown> | null
    const sshHost = (parsed?.terminal as Record<string, unknown> | undefined)
      ?.ssh_host
    return typeof sshHost === 'string' ? sshHost : null
  } catch {
    return null
  }
}

/** Read a hermes profile's terminal.backend for execution auto-detection. */
export function detectExecutionFromProfile(
  profileId: string,
): AgentExecution | null {
  const configPath = path.join(
    homedir(),
    '.hermes',
    'profiles',
    profileId,
    'config.yaml',
  )
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw) as Record<string, unknown> | null
    const backend = (parsed?.terminal as Record<string, unknown> | undefined)
      ?.backend
    if (backend === 'ssh') return 'ssh'
    if (typeof backend === 'string') return 'local'
    return null
  } catch {
    return null
  }
}

function listHermesProfiles(): Array<string> {
  const dir = path.join(homedir(), '.hermes', 'profiles')
  const deletedDir = path.join(dir, '.deleted')
  let tombstoned = new Set<string>()
  try {
    tombstoned = new Set(
      fs
        .readdirSync(deletedDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    )
  } catch {
    tombstoned = new Set()
  }
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !tombstoned.has(entry.name),
      )
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function loadAgentsRegistry(input?: {
  repoRoot?: string
  /** Legacy capability inheritance hook; unified entries should declare these directly. */
  swarmCapabilities?: Map<string, Array<string>>
  /** Existing file content override (tests). When set, skips disk seed copy. */
  rawYaml?: string
}): AgentsRegistry {
  const repoRoot = input?.repoRoot ?? process.cwd()
  const filePath = getAgentsYamlPath(repoRoot)

  let doc: {
    version?: number
    agents?: Array<Record<string, unknown>>
  } | null

  if (input?.rawYaml != null) {
    doc = YAML.parse(input.rawYaml) as {
      version?: number
      agents?: Array<Record<string, unknown>>
    } | null
  } else {
    ensureAgentsYamlFromExample(repoRoot)
    if (!fs.existsSync(filePath)) {
      return {
        version: 1,
        agents: [],
        byId: new Map(),
        orphanProfiles: listHermesProfiles(),
      }
    }
    doc = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as {
      version?: number
      agents?: Array<Record<string, unknown>>
    } | null
  }

  const errors: Array<string> = []
  const agents: Array<AgentDeclaration> = []

  for (const entry of doc?.agents ?? []) {
    const id = String(entry.id ?? '')
    const runtime = String(entry.runtime ?? '') as AgentRuntimeKind
    if (!id) {
      errors.push('agent entry missing id')
      continue
    }
    if (!RUNTIMES.includes(runtime)) {
      errors.push(`agent ${id}: unknown runtime "${runtime}"`)
      continue
    }

    let execution: AgentExecution
    if (entry.execution === 'ssh' || entry.execution === 'local') {
      execution = entry.execution
    } else {
      execution =
        (entry.profile
          ? detectExecutionFromProfile(String(entry.profile))
          : null) ?? 'local'
    }

    if (runtime !== 'hermes' && execution === 'ssh') {
      errors.push(
        `agent ${id}: execution=ssh is only supported for runtime=hermes ` +
          `(CLI adapters spawn the process locally; ssh would require exposing the MCP endpoint)`,
      )
      continue
    }

    if (runtime === 'hermes' && !entry.profile) {
      entry.profile = id
    }
    if (runtime !== 'hermes' && !entry.command) {
      errors.push(`agent ${id}: runtime=${runtime} requires a command`)
      continue
    }

    const inherited = input?.swarmCapabilities?.get(id) ?? []
    const capabilities = Array.isArray(entry.capabilities)
      ? (entry.capabilities as Array<string>)
      : inherited

    agents.push({
      id,
      name: entry.name ? String(entry.name) : undefined,
      role: entry.role ? String(entry.role) : undefined,
      specialty: entry.specialty ? String(entry.specialty) : undefined,
      mission: entry.mission ? String(entry.mission) : undefined,
      runtime,
      profile: entry.profile ? String(entry.profile) : undefined,
      ensureProfile: entry.ensureProfile === true,
      command: entry.command ? String(entry.command) : undefined,
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      modes: Array.isArray(entry.modes) ? entry.modes.map(String) : [],
      tools: Array.isArray(entry.tools) ? entry.tools.map(String) : [],
      skills: Array.isArray(entry.skills) ? entry.skills.map(String) : [],
      plugins: Array.isArray(entry.plugins) ? entry.plugins.map(String) : [],
      pluginToolsets: Array.isArray(entry.pluginToolsets)
        ? entry.pluginToolsets.map(String)
        : [],
      mcpServers: Array.isArray(entry.mcpServers)
        ? entry.mcpServers.map(String)
        : [],
      wrapper: entry.wrapper ? String(entry.wrapper) : undefined,
      model: entry.model ? String(entry.model) : undefined,
      execution,
      capabilities,
      preferredTaskTypes: Array.isArray(entry.preferredTaskTypes)
        ? entry.preferredTaskTypes.map(String)
        : [],
      greenlightRequiredFor: Array.isArray(entry.greenlightRequiredFor)
        ? entry.greenlightRequiredFor.map(String)
        : [],
      acceptsBroadcast: entry.acceptsBroadcast !== false,
      reviewRequired: entry.reviewRequired === true,
      dispatchable: entry.dispatchable !== false,
      maxConcurrentTasks:
        typeof entry.maxConcurrentTasks === 'number'
          ? entry.maxConcurrentTasks
          : 1,
      mentionName: entry.mentionName ? String(entry.mentionName) : undefined,
      displayName: entry.displayName ? String(entry.displayName) : undefined,
    })
  }

  if (errors.length > 0) {
    throw new Error(
      `agents.yaml validation failed:\n  - ${errors.join('\n  - ')}`,
    )
  }

  const declaredProfiles = new Set(agents.map((a) => a.profile).filter(Boolean))
  const orphanProfiles = listHermesProfiles().filter(
    (p) => !declaredProfiles.has(p),
  )

  if (!declaredProfiles.has('default')) {
    orphanProfiles.unshift('default')
  }

  return {
    version: doc?.version ?? 1,
    agents,
    byId: new Map(agents.map((a) => [a.id, a])),
    orphanProfiles,
  }
}
