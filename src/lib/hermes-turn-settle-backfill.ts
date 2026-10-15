/**
 * Tutti-aligned settle backfill helpers (pure).
 *
 * During `settling`, stamp a longer authoritative assistant text onto the live
 * host — never whole-page history replace.
 */

import type { AgentActivityUpdatedEvent } from '@agorax/agent-activity-core'

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
 * Prefer the last assistant message after `baselineCount` that has body text.
 * Falls back to any last assistant with text in the full list.
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
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    const text = assistantPlainTextFromHistoryMessage(msg)
    if (text) return text
  }
  return ''
}

/**
 * Whether history text should replace live text (strictly longer / live empty).
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
  return auth.length > live.length
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
