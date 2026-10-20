/**
 * Shared send-time optimistic user (Hermes + managed).
 *
 * Seeds only `user:<clientSubmitId>` into the Engine message bucket.
 * Open-turn UI uses transcript `processing:<clientSubmitId>` (not a message
 * row) until daemon/SSE writes the first durable assistant messageId.
 */

import {
  selectEngineSession,
  type AgentActivityDurableMessage,
  type AgentSessionEngine,
} from '@agorax/agent-activity-core'

type RememberedOpenTurn = {
  clientSubmitId: string
  turnId: string
}

/** Open-turn nonce per session — turn identity, not a messageId. */
const rememberedOpenTurnBySession = new Map<string, RememberedOpenTurn>()

export function rememberOpenTurn(input: {
  agentSessionId: string
  clientSubmitId: string
  turnId: string
}): void {
  const agentSessionId = input.agentSessionId.trim()
  const clientSubmitId = input.clientSubmitId.trim()
  const turnId = input.turnId.trim()
  if (!agentSessionId || !clientSubmitId) return
  rememberedOpenTurnBySession.set(agentSessionId, {
    clientSubmitId,
    turnId: turnId || `turn-${clientSubmitId}`,
  })
}

export function clearRememberedOpenTurn(agentSessionId: string): void {
  rememberedOpenTurnBySession.delete(agentSessionId.trim())
}

export function getRememberedOpenTurn(
  agentSessionId: string,
): RememberedOpenTurn | null {
  return rememberedOpenTurnBySession.get(agentSessionId.trim()) ?? null
}

/** Test helper — do not use in product paths. */
export function __resetRememberedOpenTurnForTests(): void {
  rememberedOpenTurnBySession.clear()
}

export function ingestEngineUserPromptMessage(input: {
  engine: AgentSessionEngine
  workspaceId: string
  agentSessionId: string
  clientSubmitId: string
  text: string
  occurredAtUnixMs?: number
  /** When the Engine has no session row yet (first paint / new chat). */
  ensureSession?: (args: {
    workspaceId: string
    agentSessionId: string
  }) => void
}): void {
  const agentSessionId = input.agentSessionId?.trim() ?? ''
  const clientSubmitId = input.clientSubmitId?.trim() ?? ''
  const text = input.text?.trim() ?? ''
  if (!agentSessionId || !clientSubmitId || !text) return
  const workspaceId = input.workspaceId?.trim() || 'default'
  if (!selectEngineSession(input.engine.getSnapshot(), agentSessionId)) {
    input.ensureSession?.({ workspaceId, agentSessionId })
  }
  const occurredAtUnixMs = input.occurredAtUnixMs ?? Date.now()
  const turnId = `turn-${clientSubmitId}`
  const userMessage: AgentActivityDurableMessage = {
    workspaceId,
    agentSessionId,
    messageId: `user:${clientSubmitId}`,
    version: occurredAtUnixMs,
    sequence: occurredAtUnixMs,
    turnId,
    role: 'user',
    kind: 'text',
    status: null,
    payload: { text, content: text, clientSubmitId, displayPrompt: text },
    occurredAtUnixMs,
  }
  rememberOpenTurn({ agentSessionId, clientSubmitId, turnId })
  input.engine.dispatch({
    type: 'message/snapshotReceived',
    messages: [userMessage],
  })
}
