import { agentActivityComposerOptionsFromDaemonResult } from '@agorax/agent-activity-daemon-adapter'
import { providerIdForAgentRuntime } from '../lib/managed-agent-runtime/provider-status'
import { getAgentRuntimeRouter } from './agent-runtime/router'
import { AgoraxManagedAgentHttpClient } from './agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from './agent-runtime/agorax-managed-agent-session-identity'

export async function buildAgentCommands(agentId: string, sessionId?: string, signal?: AbortSignal) {
  const agent = getAgentRuntimeRouter().registry.byId.get(agentId)
  if (!agent || agent.runtime === 'hermes') throw new Error('Managed Agent is unavailable')
  const provider = providerIdForAgentRuntime(agent.runtime)
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!provider || !baseUrl || !workspaceId) throw new Error('Managed Agent daemon is not configured')
  const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
  let agentSessionId: string | undefined
  if (sessionId) {
    const identity = await resolveAgoraxManagedSessionIdentity({ agentId, sessionId })
    if (!identity.ok) throw new Error(identity.error)
    agentSessionId = identity.agentSessionId
  }
  const options = agentActivityComposerOptionsFromDaemonResult(provider, await client.getComposerOptions({ provider, agentSessionId, signal }))
  return { commands: options.commands, capabilities: options.capabilities, authoritative: options.slashCommandPolicy?.commandCatalogAuthoritative === true }
}