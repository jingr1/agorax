/**
 * Shared create-agent flow for Agents page and Settings registry.
 *
 * Contract:
 * 1. Always register via POST /api/agent-registry (all runtimes).
 * 2. Hermes must create/claim a profile first via POST /api/profiles/create
 *    (optional cloneFrom / model / provider), then register.
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

export type CreateAgentInput = {
  /** Registry agent id; defaults to slug of name. */
  id?: string
  name: string
  runtime: CreateAgentRuntime
  role?: string
  specialty?: string
  /** Hermes profile name; defaults to agent id. */
  profile?: string
  cloneFrom?: string
  model?: string
  provider?: string
  systemPrompt?: string
  description?: string
  command?: string
  args?: string | Array<string>
}

export type CreateAgentResult = {
  id: string
  runtime: CreateAgentRuntime
  profile?: string
  profileCreated: boolean
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

export async function registerAgentDeclaration(input: {
  id: string
  name: string
  runtime: CreateAgentRuntime
  profile?: string
  command?: string
  args?: string | Array<string>
  role?: string
  specialty?: string
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

/**
 * Canonical create used by Agents New Agent and Settings Add agent.
 */
export async function createAgentConsistent(
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  const id = normalizeAgentId(input.id || input.name)
  if (!id) throw new Error('Agent name is required')
  if (id === 'default') {
    throw new Error('"default" is reserved — pick another name')
  }

  const name = input.name.trim() || id
  let profileCreated = false
  let profile: string | undefined

  if (input.runtime === 'hermes') {
    profile = normalizeAgentId(input.profile || id) || id
    const ensured = await ensureHermesProfile({
      name: profile,
      cloneFrom: input.cloneFrom,
      model: input.model,
      provider: input.provider,
      systemPrompt: input.systemPrompt,
      description: input.description,
    })
    profileCreated = ensured.created
  }

  await registerAgentDeclaration({
    id,
    name,
    runtime: input.runtime,
    profile,
    command: input.command,
    args: input.args,
    role: input.role,
    specialty: input.specialty,
  })

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('agorax:agents-changed'))
  }

  return { id, runtime: input.runtime, profile, profileCreated }
}
