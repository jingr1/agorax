/**
 * Tutti-aligned settle backfill helpers (pure).
 *
 * During `settling`, stamp a longer authoritative assistant text onto the live
 * host — never whole-page history replace.
 */

import type { AgentActivityUpdatedEvent } from '@agorax/agent-activity-core'
import { stripWorkspaceDirective } from './workspace-message-scope'

export type HistoryLikeMessage = {
  role?: string
  content?: unknown
  text?: unknown
}

export function hermesSettledTurnUpdate(input: {
  workspaceId: string
  agentSessionId: string
  turnId: string
  outcome: 'completed' | 'failed' | 'canceled' | 'interrupted'
  errorMessage?: string
  nowUnixMs?: number
}): AgentActivityUpdatedEvent {
  const ts = input.nowUnixMs ?? Date.now()
  return {
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    eventType: 'turn_update',
    data: {
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      eventType: 'turn_update',
      occurredAtUnixMs: ts,
      activeTurnId: null,
      turn: {
        turnId: input.turnId,
        agentSessionId: input.agentSessionId,
        phase: 'settled',
        origin: 'user_prompt',
        outcome: input.outcome,
        error: input.errorMessage ? { message: input.errorMessage } : null,
        fileChanges: null,
        completedCommand: null,
        startedAtUnixMs: ts,
        settledAtUnixMs: ts,
        updatedAtUnixMs: ts,
      },
    },
  } as AgentActivityUpdatedEvent
}

export function hermesAssistantTextStampDelta(input: {
  workspaceId: string
  agentSessionId: string
  turnId: string
  messageId: string
  text: string
  nowUnixMs?: number
}): AgentActivityUpdatedEvent {
  const ts = input.nowUnixMs ?? Date.now()
  return {
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    eventType: 'message_delta',
    data: {
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      messageId: input.messageId,
      turnId: input.turnId,
      role: 'assistant',
      kind: 'text',
      occurredAtUnixMs: ts,
      content: { operation: 'set', value: input.text },
      status: 'completed',
    },
  } as AgentActivityUpdatedEvent
}

/** Extract plain assistant text from a gateway/history message shape. */
export function assistantPlainTextFromHistoryMessage(
  message: HistoryLikeMessage | null | undefined,
): string {
  if (!message) return ''
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text.trim()
  }
  if (!Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as Record<string, unknown>
    if (rec.type === 'text' && typeof rec.text === 'string') {
      const t = rec.text.trim()
      if (t) parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Index after the last user row — assistants before this belong to prior turns.
 * Settle backfill must never stamp an earlier turn's greeting onto the live host.
 */
export function baselineAfterLastUserMessage(
  messages: readonly HistoryLikeMessage[],
): number {
  let baseline = 0
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') baseline = i + 1
  }
  return baseline
}

function historyUserPlainText(message: HistoryLikeMessage): string {
  let raw = ''
  if (typeof message.text === 'string' && message.text.trim()) {
    raw = message.text.trim()
  } else if (Array.isArray(message.content)) {
    const parts: string[] = []
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (
        rec.type === 'text' &&
        typeof rec.text === 'string' &&
        rec.text.trim()
      ) {
        parts.push(rec.text.trim())
      }
    }
    raw = parts.join('\n').trim()
  }
  // Gateway persists Workspace::v1 envelope; open turn holds bare prompt.
  return stripWorkspaceDirective(raw).trim()
}

function historyUserClientSubmitId(message: HistoryLikeMessage): string {
  const rec = message as HistoryLikeMessage & {
    clientId?: unknown
    client_id?: unknown
    clientSubmitId?: unknown
    payload?: { clientSubmitId?: unknown }
  }
  for (const value of [
    rec.clientSubmitId,
    rec.clientId,
    rec.client_id,
    rec.payload?.clientSubmitId,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Baseline after the open turn's user row. Returns null when history does not
 * yet contain this turn — callers must not fall back to a prior user (that
 * stamped the previous reply under the new prompt).
 */
export function baselineAfterOpenTurnUser(
  messages: readonly HistoryLikeMessage[],
  open: { clientSubmitId?: string; userText?: string },
): number | null {
  const submit = open.clientSubmitId?.trim() ?? ''
  const userText = stripWorkspaceDirective(open.userText?.trim() ?? '').trim()
  if (!submit && !userText) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i]
    if (!row || row.role !== 'user') continue
    const rowSubmit = historyUserClientSubmitId(row)
    if (submit && rowSubmit && rowSubmit === submit) return i + 1
    if (userText && historyUserPlainText(row) === userText) return i + 1
  }
  return null
}

/**
 * Prefer the last assistant message after `baselineCount` that has body text.
 * Does not fall back to earlier turns — empty recent slice means no stamp.
 */
export function pickAuthoritativeAssistantText(
  messages: readonly HistoryLikeMessage[],
  baselineCount = 0,
): string {
  const sliceFrom = Math.max(0, Math.min(baselineCount, messages.length))
  const recent = messages.slice(sliceFrom)
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const msg = recent[i]
    if (!msg || msg.role !== 'assistant') continue
    const text = assistantPlainTextFromHistoryMessage(msg)
    if (text) return text
  }
  return ''
}

/**
 * Whether history text should replace live text.
 *
 * Only when live is empty, or authoritative is a completion of the same stream
 * (`auth.startsWith(live)`). Never stamp merely because auth is longer — that
 * pulled the previous turn's reply onto a new short host when history lagged.
 */
export function shouldStampAssistantText(
  liveText: string,
  authoritativeText: string,
): boolean {
  const live = liveText.trim()
  const auth = authoritativeText.trim()
  if (!auth) return false
  if (!live) return true
  if (auth === live) return false
  return auth.startsWith(live)
}

/**
 * Skip /api/history when done.message already stamped final body text.
 * History remains the backup when the stream omitted done.message text.
 */
export function shouldFetchHistoryForSettle(input: {
  doneCarriedFinalText: boolean
  liveText: string
}): boolean {
  if (input.doneCarriedFinalText && input.liveText.trim()) return false
  return true
}
