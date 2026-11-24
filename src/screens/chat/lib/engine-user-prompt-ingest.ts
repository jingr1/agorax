/**
 * Shared send-time optimistic user (Hermes + managed) — Tutti contract.
 *
 * Seeds the user into the **overlay only** via `seedOptimisticMessage`.
 * Engine durable bucket stays empty until Host/daemon truth arrives; authoritative
 * reconcile drops the overlay row by clientSubmitId / turn.
 *
 * Open-turn UI uses transcript `processing:<clientSubmitId>` (not a message
 * row) until daemon/SSE writes the first durable assistant messageId.
 *
 * Hard gate: while a prior open turn is remembered (or Engine still has an
 * unsettled activeTurn), refuse a *different* clientSubmitId. UI queue/drain
 * must not be the only door — ingest is the last line that keeps prior-turn
 * hosts from sharing the list with a premature follow-up user.
 */

import {
  selectEngineActiveTurn,
  selectEngineSession,
  type AgentActivityMessage,
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
  /**
   * Tutti overlay seed — required. Product paths pass
   * `coordinator.seedOptimisticMessage`; tests may use a real coordinator or
   * a stub that records the message for projection.
   */
  seedOptimisticMessage: (message: AgentActivityMessage) => boolean
  workspaceId: string
  agentSessionId: string
  clientSubmitId: string
  text: string
  occurredAtUnixMs?: number
  /**
   * Durable user messageId. Hermes: `user:<submitId>`.
   * Managed/Tutti Host: `client-submit:user:<submitId>` (must match daemon).
   */
  userMessageId?: string
  /** When the Engine has no session row yet (first paint / new chat). */
  ensureSession?: (args: {
    workspaceId: string
    agentSessionId: string
  }) => void
}): boolean {
  const agentSessionId = input.agentSessionId?.trim() ?? ''
  const clientSubmitId = input.clientSubmitId?.trim() ?? ''
  const text = input.text?.trim() ?? ''
  if (!agentSessionId || !clientSubmitId || !text) return false
  const workspaceId = input.workspaceId?.trim() || 'default'
  if (!selectEngineSession(input.engine.getSnapshot(), agentSessionId)) {
    input.ensureSession?.({ workspaceId, agentSessionId })
  }

  const remembered = getRememberedOpenTurn(agentSessionId)
  if (remembered && remembered.clientSubmitId !== clientSubmitId) {
    return false
  }
  const activeTurn = selectEngineActiveTurn(
    input.engine.getSnapshot(),
    agentSessionId,
  )
  if (
    activeTurn &&
    activeTurn.phase !== 'settled' &&
    remembered?.clientSubmitId !== clientSubmitId
  ) {
    // Open Engine turn from a prior submit — do not seed a sibling user row.
    return false
  }

  const occurredAtUnixMs = input.occurredAtUnixMs ?? Date.now()
  const turnId = `turn-${clientSubmitId}`
  const userMessageId =
    (typeof input.userMessageId === 'string' && input.userMessageId.trim()) ||
    `user:${clientSubmitId}`
  const userMessage: AgentActivityMessage = {
    workspaceId,
    agentSessionId,
    messageId: userMessageId,
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
  return input.seedOptimisticMessage(userMessage)
}

/** Tutti/Managed Host durable user id — must match daemon prompt_content.go. */
export function managedClientSubmitUserMessageId(
  clientSubmitId: string,
): string {
  return `client-submit:user:${clientSubmitId.trim()}`
}
