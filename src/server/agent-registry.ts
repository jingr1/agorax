import {
  deleteProfile,
  isLiveNamedProfile,
} from './profiles-browser'
import {
  deleteSwarmRosterWorker,
  readSwarmRoster,
  SwarmRosterUpsertSchema,
  upsertSwarmRosterWorker,
  patchSwarmRosterWorker,
  type SwarmRosterUpsert,
  isSwarmWorkerId,
} from './swarm-roster'
import { listSwarmWorkerIds } from './swarm-foundation'
import { resetAgentRuntimeRouter } from './agent-runtime/router'
import type { AgentRuntimeKind } from './agent-runtime/types'
import { AGORAX_MANAGED_AGENT_BACKENDS } from '@/lib/managed-agent-runtime/agent-targets'

// Derived from the single source of truth; add a managed runtime in
// `@/lib/managed-agent-runtime/agent-targets` (AGORAX_MANAGED_AGENT_BACKENDS).
const MANAGED_RUNTIMES: ReadonlySet<string> = new Set(AGORAX_MANAGED_AGENT_BACKENDS)
const SUPPORTED_RUNTIMES: ReadonlySet<string> = new Set(['hermes', ...MANAGED_RUNTIMES])
const DEFAULT_AGENT = {
  id: 'default',
  name: 'Default',
  role: 'Default Hermes Agent',
  specialty: 'General assistant',
  mission: 'Default Hermes Agent profile.',
  profile: 'default',
  modes: [],
  tools: [],
  skills: [],
  plugins: [],
  pluginToolsets: [],
  mcpServers: [],
  capabilities: [],
  preferredTaskTypes: [],
  greenlightRequiredFor: [],
  maxConcurrentTasks: 1,
  acceptsBroadcast: true,
  reviewRequired: false,
  runtime: 'hermes' as const,
  execution: 'local' as const,
  dispatchable: false,
  enabled: true,
}

function rosterIds(): Array<string> {
  return listSwarmWorkerIds().filter(
    (id) => id !== 'workspace' && isSwarmWorkerId(id),
  )
}

function normalizeInput(input: Record<string, unknown>): SwarmRosterUpsert {
  const requestedRuntime = String(input.runtime ?? 'hermes')
  if (!SUPPORTED_RUNTIMES.has(requestedRuntime)) {
    throw new Error(`Unsupported agent runtime: ${requestedRuntime}`)
  }
  const runtime = requestedRuntime as AgentRuntimeKind
  const id = String(input.id ?? '').trim()
  const profile = runtime === 'hermes'
    ? String(input.profile ?? id).trim()
    : undefined
  const defaultCommandByRuntime: Record<string, string> = {
    codex: 'codex',
    'claude-code': 'claude',
    cursor: 'cursor',
    opencode: 'opencode',
    kimi: 'kimi',
  }
  const command = runtime === 'hermes'
    ? undefined
    : String(input.command ?? defaultCommandByRuntime[runtime] ?? runtime).trim()

  if (!id) throw new Error('Agent ID is required')
  if (runtime === 'hermes' && !profile) {
    throw new Error('Hermes agents require a profile')
  }
  if (MANAGED_RUNTIMES.has(runtime) && !command) {
    throw new Error(`${runtime} agents require a command`)
  }

  return SwarmRosterUpsertSchema.parse({
    ...input,
    id,
    runtime,
    profile,
    command,
    args: Array.isArray(input.args)
      ? input.args
      : typeof input.args === 'string'
        ? input.args.split(/\s+/).filter(Boolean)
        : undefined,
    name: String(input.name ?? id),
    role: String(input.role ?? 'Worker'),
    mission: String(input.mission ?? 'Awaiting orchestrator dispatch.'),
  })
}

export function listAgentDeclarations() {
  // Agents UI (/agents) manages declarations, not every profile discovered on disk.
  // Orphan profiles are surfaced separately for an explicit import/claim flow.
  const workers = readSwarmRoster([]).workers
  return workers.some((worker) => worker.id === 'default')
    ? workers
    : [DEFAULT_AGENT, ...workers]
}

export function createAgentDeclaration(input: Record<string, unknown>) {
  const next = normalizeInput(input)
  if (next.id === 'default') {
    throw new Error('The default Hermes Agent is managed by the runtime')
  }
  if (next.runtime === 'hermes') {
    const profile = next.profile ?? next.id
    if (!isLiveNamedProfile(profile)) {
      throw new Error(
        `Hermes profile "${profile}" does not exist. Create it first via POST /api/profiles/create (Agents → New Agent Hermes profile step).`,
      )
    }
  }
  const roster = upsertSwarmRosterWorker(next, rosterIds())
  resetAgentRuntimeRouter()
  return roster
}

export function updateAgentDeclaration(
  agentId: string,
  input: Record<string, unknown>,
) {
  const current = listAgentDeclarations().find((agent) => agent.id === agentId)
  if (!current) throw new Error(`Agent ${agentId} not found`)
  if (agentId === 'default') {
    throw new Error('The default Hermes Agent cannot be edited')
  }
  const currentProfile =
    current.runtime === 'hermes' ? (current.profile ?? current.id) : undefined
  const next = normalizeInput({
    ...current,
    ...input,
    id: agentId,
    profile: input.profile ?? currentProfile,
  })
  if (current.runtime !== next.runtime) {
    throw new Error('Changing runtime requires creating a new agent')
  }
  if (current.runtime === 'hermes' && currentProfile !== next.profile) {
    throw new Error('Changing a Hermes profile requires creating a new agent')
  }
  const roster = patchSwarmRosterWorker(agentId, next, rosterIds())
  resetAgentRuntimeRouter()
  return roster
}

export function deleteAgentDeclaration(agentId: string) {
  const current = listAgentDeclarations().find((agent) => agent.id === agentId)
  if (!current) throw new Error(`Agent ${agentId} not found`)
  if (agentId === 'default') {
    throw new Error('The default Hermes Agent cannot be deleted')
  }
  const roster = deleteSwarmRosterWorker(agentId, rosterIds())
  if (current.runtime === 'hermes') {
    deleteProfile(current.profile ?? current.id)
  }
  resetAgentRuntimeRouter()
  return roster
}