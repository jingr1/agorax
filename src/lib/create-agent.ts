/**
 * Shared create-agent flow for Agents page and Settings registry.
 *
 * Contract:
 * 1. Always register via POST /api/agent-registry (all runtimes).
 * 2. Hermes profile setup (hermesSetup):
 *    - `new` — POST /api/profiles/create (optional cloneFrom seed), then register
 *    - `existing` — bind a live unbound profile; skip create
 *    - `clone-agent` — clone source agent's profile FS + copy declaration fields
 */
import {
  AGORAX_MANAGED_AGENT_BACKENDS,
  type AgoraxManagedAgentBackend,
} from '@/lib/managed-agent-runtime/agent-targets'

export type CreateAgentRuntime =
  | 'hermes'
  | AgoraxManagedAgentBackend

export const CREATE_AGENT_RUNTIMES: Array<CreateAgentRuntime> = [
  'hermes',
  ...AGORAX_MANAGED_AGENT_BACKENDS,
]

/** How Hermes obtains its profile when creating an agent. */
export type HermesProfileSetup = 'new' | 'existing' | 'clone-agent'

export type CreateAgentInput = {
  /** Registry agent id; defaults to slug of name. */
  id?: string
  name: string
  runtime: CreateAgentRuntime
  role?: string
  specialty?: string
  mission?: string
  /** Hermes profile name; defaults to agent id. */
  profile?: string
  /**
   * Hermes setup mode. Default `new`.
   * - `new` — create profile (optional `cloneFrom` seed)
   * - `existing` — claim `existingProfile` (must already exist)
   * - `clone-agent` — clone profile + declaration from `cloneAgentId`
   */
  hermesSetup?: HermesProfileSetup
  /** When hermesSetup=existing: live profile to bind. */
  existingProfile?: string
  /** When hermesSetup=clone-agent: source registry agent id. */
  cloneAgentId?: string
  /** When hermesSetup=new: optional profile to seed config from. */
  cloneFrom?: string
  model?: string
  provider?: string
  systemPrompt?: string
  description?: string
  command?: string
  args?: string | Array<string>
  modes?: Array<string>
  tools?: Array<string>
  skills?: Array<string>
  plugins?: Array<string>
  pluginToolsets?: Array<string>
  mcpServers?: Array<string>
  capabilities?: Array<string>
  preferredTaskTypes?: Array<string>
  greenlightRequiredFor?: Array<string>
  wrapper?: string
  maxConcurrentTasks?: number
  acceptsBroadcast?: boolean
  reviewRequired?: boolean
  dispatchable?: boolean
  ensureProfile?: boolean
}

export type CreateAgentResult = {
  id: string
  runtime: CreateAgentRuntime
  profile?: string
  profileCreated: boolean
  hermesSetup: HermesProfileSetup
}

type AgentDeclarationRow = {
  id: string
  name?: string
  runtime?: string
  profile?: string
  role?: string
  specialty?: string
  mission?: string
  modes?: Array<string>
  tools?: Array<string>
  skills?: Array<string>
  plugins?: Array<string>
  pluginToolsets?: Array<string>
  mcpServers?: Array<string>
  capabilities?: Array<string>
  preferredTaskTypes?: Array<string>
  greenlightRequiredFor?: Array<string>
  wrapper?: string
  command?: string
  args?: Array<string>
  maxConcurrentTasks?: number
  acceptsBroadcast?: boolean
  reviewRequired?: boolean
  dispatchable?: boolean
  ensureProfile?: boolean
}

export function normalizeAgentId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

/**
 * Ensure Hermes profile exists via /api/profiles/create.
 * If it already exists, treat as success (claim existing).
 */
export async function ensureHermesProfile(input: {
  name: string
  cloneFrom?: string
  model?: string
  provider?: string
  systemPrompt?: string
  description?: string
}): Promise<{ created: boolean }> {
  const response = await fetch('/api/profiles/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      cloneFrom: input.cloneFrom || undefined,
      model: input.model || undefined,
      provider: input.provider || undefined,
    }),
  })
  const payload = await readJson(response)
  const error = typeof payload.error === 'string' ? payload.error : ''
  if (response.ok && payload.ok !== false) {
    if (input.systemPrompt?.trim() || input.description?.trim()) {
      await fetch('/api/profiles/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          patch: {
            system_prompt: input.systemPrompt?.trim() || undefined,
            description: input.description?.trim() || undefined,
          },
        }),
      })
    }
    return { created: true }
  }
  if (/already exists/i.test(error)) {
    return { created: false }
  }
  throw new Error(error || `Failed to create profile (${response.status})`)
}

async function fetchAgentDeclaration(
  agentId: string,
): Promise<AgentDeclarationRow> {
  const response = await fetch('/api/agent-registry')
  const payload = await readJson(response)
  if (!response.ok || payload.ok === false) {
    throw new Error(
      (typeof payload.error === 'string' && payload.error) ||
        `Failed to load agents (${response.status})`,
    )
  }
  const agents = Array.isArray(payload.agents)
    ? (payload.agents as Array<AgentDeclarationRow>)
    : []
  const found = agents.find((agent) => agent.id === agentId)
  if (!found) {
    throw new Error(`Source agent "${agentId}" not found`)
  }
  return found
}

export async function registerAgentDeclaration(input: {
  id: string
  name: string
  runtime: CreateAgentRuntime
  profile?: string
  command?: string
  args?: string | Array<string>
  role?: string
  specialty?: string
  mission?: string
  modes?: Array<string>
  tools?: Array<string>
  skills?: Array<string>
  plugins?: Array<string>
  pluginToolsets?: Array<string>
  mcpServers?: Array<string>
  capabilities?: Array<string>
  preferredTaskTypes?: Array<string>
  greenlightRequiredFor?: Array<string>
  wrapper?: string
  maxConcurrentTasks?: number
  acceptsBroadcast?: boolean
  reviewRequired?: boolean
  dispatchable?: boolean
  ensureProfile?: boolean
}): Promise<void> {
  const response = await fetch('/api/agent-registry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: input.id,
      name: input.name,
      runtime: input.runtime,
      profile: input.runtime === 'hermes' ? input.profile : undefined,
      command: input.runtime === 'hermes' ? undefined : input.command,
      args: input.args,
      role: input.role || 'Worker',
      specialty: input.specialty || '',
      mission: input.mission,
      modes: input.modes,
      tools: input.tools,
      skills: input.skills,
      plugins: input.plugins,
      pluginToolsets: input.pluginToolsets,
      mcpServers: input.mcpServers,
      capabilities: input.capabilities,
      preferredTaskTypes: input.preferredTaskTypes,
      greenlightRequiredFor: input.greenlightRequiredFor,
      wrapper: input.wrapper,
      maxConcurrentTasks: input.maxConcurrentTasks,
      acceptsBroadcast: input.acceptsBroadcast,
      reviewRequired: input.reviewRequired,
      dispatchable: input.dispatchable,
      ensureProfile: input.ensureProfile,
    }),
  })
  const payload = await readJson(response)
  if (!response.ok || payload.ok === false) {
    throw new Error(
      (typeof payload.error === 'string' && payload.error) ||
        `Failed to register agent (${response.status})`,
    )
  }
}

/** Pure plan for Hermes create — used by createAgentConsistent and tests. */
export function planHermesAgentCreate(input: CreateAgentInput): {
  hermesSetup: HermesProfileSetup
  id: string
  name: string
  profile: string
  shouldCreateProfile: boolean
  cloneFrom?: string
  cloneAgentId?: string
} {
  const id = normalizeAgentId(input.id || input.name)
  if (!id) throw new Error('Agent name is required')
  if (id === 'default') {
    throw new Error('"default" is reserved — pick another name')
  }
  const name = input.name.trim() || id
  const hermesSetup: HermesProfileSetup = input.hermesSetup ?? 'new'

  if (hermesSetup === 'existing') {
    const profile =
      normalizeAgentId(input.existingProfile || input.profile || id) || id
    return {
      hermesSetup,
      id,
      name,
      profile,
      shouldCreateProfile: false,
    }
  }

  if (hermesSetup === 'clone-agent') {
    const cloneAgentId = String(input.cloneAgentId ?? '').trim()
    if (!cloneAgentId) {
      throw new Error('Select an agent to clone')
    }
    if (cloneAgentId === id) {
      throw new Error('Clone target must differ from the new agent id')
    }
    const profile = normalizeAgentId(input.profile || id) || id
    return {
      hermesSetup,
      id,
      name,
      profile,
      shouldCreateProfile: true,
      cloneAgentId,
    }
  }

  const profile = normalizeAgentId(input.profile || id) || id
  return {
    hermesSetup: 'new',
    id,
    name,
    profile,
    shouldCreateProfile: true,
    cloneFrom: input.cloneFrom || undefined,
  }
}

/**
 * Canonical create used by Agents New Agent and Settings Add agent.
 */
export async function createAgentConsistent(
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  const hermesSetup: HermesProfileSetup =
    input.runtime === 'hermes' ? (input.hermesSetup ?? 'new') : 'new'

  let id = normalizeAgentId(input.id || input.name)
  if (!id) throw new Error('Agent name is required')
  if (id === 'default') {
    throw new Error('"default" is reserved — pick another name')
  }

  let name = input.name.trim() || id
  let profileCreated = false
  let profile: string | undefined
  let declarationExtras: Partial<CreateAgentInput> = {}

  if (input.runtime === 'hermes') {
    const plan = planHermesAgentCreate(input)
    id = plan.id
    name = plan.name
    profile = plan.profile

    if (plan.hermesSetup === 'clone-agent' && plan.cloneAgentId) {
      const source = await fetchAgentDeclaration(plan.cloneAgentId)
      if ((source.runtime || 'hermes') !== 'hermes') {
        throw new Error(
          `Cannot clone Hermes profile from ${source.runtime ?? 'unknown'} agent "${plan.cloneAgentId}"`,
        )
      }
      const sourceProfile = source.profile || source.id
      const ensured = await ensureHermesProfile({
        name: plan.profile,
        cloneFrom: sourceProfile,
        model: input.model,
        provider: input.provider,
        systemPrompt: input.systemPrompt,
        description: input.description,
      })
      profileCreated = ensured.created
      declarationExtras = {
        role: input.role ?? source.role,
        specialty: input.specialty ?? source.specialty,
        mission: input.mission ?? source.mission,
        modes: input.modes ?? source.modes,
        tools: input.tools ?? source.tools,
        skills: input.skills ?? source.skills,
        plugins: input.plugins ?? source.plugins,
        pluginToolsets: input.pluginToolsets ?? source.pluginToolsets,
        mcpServers: input.mcpServers ?? source.mcpServers,
        capabilities: input.capabilities ?? source.capabilities,
        preferredTaskTypes:
          input.preferredTaskTypes ?? source.preferredTaskTypes,
        greenlightRequiredFor:
          input.greenlightRequiredFor ?? source.greenlightRequiredFor,
        wrapper: input.wrapper ?? source.wrapper,
        maxConcurrentTasks:
          input.maxConcurrentTasks ?? source.maxConcurrentTasks,
        acceptsBroadcast: input.acceptsBroadcast ?? source.acceptsBroadcast,
        reviewRequired: input.reviewRequired ?? source.reviewRequired,
        dispatchable: input.dispatchable ?? source.dispatchable,
        ensureProfile: input.ensureProfile ?? source.ensureProfile,
      }
    } else if (plan.shouldCreateProfile) {
      const ensured = await ensureHermesProfile({
        name: plan.profile,
        cloneFrom: plan.cloneFrom,
        model: input.model,
        provider: input.provider,
        systemPrompt: input.systemPrompt,
        description: input.description,
      })
      profileCreated = ensured.created
    }
    // existing: skip create; server verifies live profile on register
  }

  await registerAgentDeclaration({
    id,
    name,
    runtime: input.runtime,
    profile,
    command: input.command ?? declarationExtras.command,
    args: input.args ?? declarationExtras.args,
    role: declarationExtras.role ?? input.role,
    specialty: declarationExtras.specialty ?? input.specialty,
    mission: declarationExtras.mission ?? input.mission,
    modes: declarationExtras.modes ?? input.modes,
    tools: declarationExtras.tools ?? input.tools,
    skills: declarationExtras.skills ?? input.skills,
    plugins: declarationExtras.plugins ?? input.plugins,
    pluginToolsets: declarationExtras.pluginToolsets ?? input.pluginToolsets,
    mcpServers: declarationExtras.mcpServers ?? input.mcpServers,
    capabilities: declarationExtras.capabilities ?? input.capabilities,
    preferredTaskTypes:
      declarationExtras.preferredTaskTypes ?? input.preferredTaskTypes,
    greenlightRequiredFor:
      declarationExtras.greenlightRequiredFor ?? input.greenlightRequiredFor,
    wrapper: declarationExtras.wrapper ?? input.wrapper,
    maxConcurrentTasks:
      declarationExtras.maxConcurrentTasks ?? input.maxConcurrentTasks,
    acceptsBroadcast:
      declarationExtras.acceptsBroadcast ?? input.acceptsBroadcast,
    reviewRequired: declarationExtras.reviewRequired ?? input.reviewRequired,
    dispatchable: declarationExtras.dispatchable ?? input.dispatchable,
    ensureProfile: declarationExtras.ensureProfile ?? input.ensureProfile,
  })

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('agorax:agents-changed'))
  }

  return {
    id,
    runtime: input.runtime,
    profile,
    profileCreated,
    hermesSetup,
  }
}
