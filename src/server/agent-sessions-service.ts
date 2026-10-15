/**
 * Unified session abstraction for the Agent Workspace UI.
 *
 * Hermes agents: profile state.db.
 * Managed agents (daemon configured): daemon Host is the sole session source
 * for list / rename / delete. collab.db managed_chat_* is legacy cleanup only.
 * Managed agents (daemon not configured): fall back to collab for legacy spawn.
 */
import { listSessionsForProfile } from './profiles-browser'
import { getAgentRuntimeRouter } from './agent-runtime/router'
import {
  createSessionForManagedAgent,
  deleteManagedChatSession,
  listManagedChatSessions,
  renameManagedChatSession,
} from './agent-runtime/managed-chat-store'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from './agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from './agent-runtime/agorax-managed-agent-bridge'
import { resolveAgoraxManagedSessionIdentity } from './agent-runtime/agorax-managed-agent-session-identity'
import { managedAgentTargetIdForRuntime } from '@/lib/managed-agent-runtime/agent-targets'
import type {
  AgentRuntime,
  AgentSession,
  AgentSessionState,
} from '../lib/agent-types'
import type { AgentActivitySession } from '@agorax/agent-activity-core'

function deriveSessionState(messageCount: number): AgentSessionState {
  return messageCount > 0 ? 'completed' : 'idle'
}

function listHermesSessions(agentId: string): Array<AgentSession> {
  const sessions = listSessionsForProfile(agentId)
  return sessions.map((session) => ({
    sessionId: session.friendlyId,
    agentId,
    title: session.title ?? session.friendlyId,
    state: deriveSessionState(session.messageCount ?? 0),
    lastMessageAt: new Date(session.updatedAt || Date.now()).toISOString(),
    summary: `Messages: ${session.messageCount ?? 0}`,
  }))
}

function managedDaemonClient(): AgoraxManagedAgentHttpClient | null {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

/** Map a daemon activity session into the sidebar AgentSession shape. */
export function agentSessionFromDaemonActivity(
  agentId: string,
  session: AgentActivitySession,
): AgentSession {
  const updatedAt =
    typeof session.updatedAtUnixMs === 'number' && session.updatedAtUnixMs > 0
      ? session.updatedAtUnixMs
      : typeof session.lastEventUnixMs === 'number' && session.lastEventUnixMs > 0
        ? session.lastEventUnixMs
        : Date.now()
  const title = session.title?.trim() || 'Chat'
  return {
    sessionId: session.agentSessionId,
    agentId,
    title,
    state: session.activeTurnId ? 'running' : 'idle',
    lastMessageAt: new Date(updatedAt).toISOString(),
    ...(session.resumable ? { summary: 'Resumable' } : {}),
  }
}

async function listManagedDaemonSessions(
  agentId: string,
  runtime: Exclude<AgentRuntime, 'hermes'>,
): Promise<Array<AgentSession>> {
  const client = managedDaemonClient()
  if (!client) {
    return listManagedChatSessions(agentId)
  }
  if (!isAgoraxManagedAgentBackend(runtime)) {
    return listManagedChatSessions(agentId)
  }
  const targetId = managedAgentTargetIdForRuntime(runtime, agentId)
  // Fail fast: hanging daemon must not leave the sidebar on "Loading sessions…".
  // Filter by target inside the client so we do not map every workspace session.
  const sessions = await client.listSessions({
    signal: AbortSignal.timeout(5_000),
    agentTargetId: targetId,
  })
  return sessions
    .map((session) => agentSessionFromDaemonActivity(agentId, session))
    .sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    )
}

export async function listSessionsForAgent(
  agentId: string,
): Promise<Array<AgentSession>> {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl) {
    if (router.registry.orphanProfiles.includes(agentId)) {
      return listHermesSessions(agentId)
    }
    return listManagedChatSessions(agentId)
  }
  if (decl.runtime === 'hermes') {
    return listHermesSessions(decl.profile ?? decl.id)
  }
  return listManagedDaemonSessions(decl.id, decl.runtime)
}

export function createSessionForAgent(
  agentId: string,
  payload: { title?: string; model?: string },
): { sessionId: string } {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  const isHermes =
    decl?.runtime === 'hermes' ||
    (!decl && router.registry.orphanProfiles.includes(agentId))
  if (isHermes) {
    // Hermes new-session creation is handled by the existing /api/sessions flow.
    return { sessionId: `new-${Date.now()}` }
  }
  return createSessionForManagedAgent(agentId, {
    runtime: decl?.runtime ?? 'claude-code',
    title: payload.title,
    model: payload.model,
  })
}

function cleanupCollabSession(agentId: string, sessionId: string): void {
  try {
    deleteManagedChatSession({ agentId, sessionId })
  } catch {
    /* legacy row may already be gone */
  }
}

export async function renameSessionForAgent(
  agentId: string,
  sessionId: string,
  title: string,
): Promise<AgentSession | null> {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl || decl.runtime === 'hermes') return null

  const client = managedDaemonClient()
  if (!client || !isAgoraxManagedAgentBackend(decl.runtime)) {
    return renameManagedChatSession({ agentId, sessionId, title })
  }

  const identity = await resolveAgoraxManagedSessionIdentity({
    agentId,
    sessionId,
  })
  if (!identity.ok) return null

  const trimmed = title.trim()
  if (!trimmed) return null

  try {
    const result = await client.updateTitle(identity.agentSessionId, trimmed)
    const canonical = result.Canonical as
      | { Title?: string; title?: string; UpdatedAtUnixMS?: number; updatedAtUnixMs?: number }
      | undefined
    const wireTitle =
      canonical?.Title?.trim() || canonical?.title?.trim() || trimmed
    const updatedAt =
      canonical?.UpdatedAtUnixMS ??
      canonical?.updatedAtUnixMs ??
      Date.now()
    return {
      sessionId: identity.agentSessionId,
      agentId,
      title: wireTitle,
      state: 'idle' as const,
      lastMessageAt: new Date(updatedAt).toISOString(),
    }
  } catch (error) {
    if (error instanceof AgoraxManagedAgentHttpError && error.status === 404) {
      return null
    }
    throw error
  }
}

export async function deleteSessionForAgent(
  agentId: string,
  sessionId: string,
): Promise<boolean> {
  const router = getAgentRuntimeRouter()
  const decl = router.registry.byId.get(agentId)
  if (!decl || decl.runtime === 'hermes') return false

  const client = managedDaemonClient()
  if (!client || !isAgoraxManagedAgentBackend(decl.runtime)) {
    return deleteManagedChatSession({ agentId, sessionId })
  }

  const identity = await resolveAgoraxManagedSessionIdentity({
    agentId,
    sessionId,
  })
  if (!identity.ok) {
    cleanupCollabSession(agentId, sessionId)
    return false
  }

  try {
    await client.deleteSession(identity.agentSessionId)
  } catch (error) {
    if (!(error instanceof AgoraxManagedAgentHttpError && error.status === 404)) {
      throw error
    }
    // Daemon already gone — still clean collab residue.
  }
  cleanupCollabSession(agentId, sessionId)
  // Also clear collab if sidebar still keyed by a legacy display id.
  if (sessionId !== identity.agentSessionId) {
    cleanupCollabSession(agentId, identity.agentSessionId)
  }
  return true
}
