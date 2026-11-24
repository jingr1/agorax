/**
 * Shared open-turn streaming chrome (Hermes + managed).
 *
 * Finds a durable assistant host already in the projected list (daemon/SSE
 * messageId). Does NOT invent `assistant:pending:…` messageIds — open-turn
 * face before the first durable assistant is transcript `processing:…`.
 *
 * Content-stream chrome (`isStreaming` / `streamingMessageId`) follows
 * Activity in-flight work, not merely Host `turnActive`. Managed providers
 * often keep the turn open after the last visible delta; forcing streaming
 * chrome for that whole window made Stop / caret hang after the reply looked
 * finished. `turnBusy` still tracks the open Host turn for queue gating.
 */

import { foldOpenTurnIntoLiveHost } from '@/lib/chat-turn-identity'
import type { ChatMessage } from '../types'

function messageIdOf(message: ChatMessage): string {
  return (
    (typeof message.messageId === 'string' && message.messageId.trim()) ||
    (typeof message.id === 'string' && message.id.trim()) ||
    ''
  )
}

function lastUserIndexOf(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

/**
 * Resolve the durable open-turn assistant host already in the projected list.
 * Only assistants *after* the latest user count — never pull a prior-turn
 * host from above (queued follow-up / Enter-while-busy used to relocate the
 * still-live reply under the new user bubble).
 */
function findOpenAssistantHost(messages: ChatMessage[]): ChatMessage | null {
  const lastUser = lastUserIndexOf(messages)
  let lastAssistantAfterUser: ChatMessage | null = null
  for (let i = lastUser + 1; i < messages.length; i += 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    lastAssistantAfterUser = message
  }
  return lastAssistantAfterUser
}

function isTerminalChatAssistant(message: ChatMessage): boolean {
  const status = (message as { __streamingStatus?: string }).__streamingStatus
  return status === 'complete' || status === 'error'
}

/**
 * activityStreamingId is safe to fold only when its row is missing (shell will
 * append after the user) or already sits after the latest user. A match above
 * the latest user is the previous turn's live host — leave it alone.
 */
function resolveStreamingMessageId(
  messages: ChatMessage[],
  openAssistantId: string | null,
  activityStreamingId: string | null,
): string | null {
  if (openAssistantId) return openAssistantId
  const activityId =
    typeof activityStreamingId === 'string' ? activityStreamingId.trim() : ''
  if (!activityId) return null
  const lastUser = lastUserIndexOf(messages)
  const index = messages.findIndex(
    (message) => messageIdOf(message) === activityId,
  )
  if (index < 0) return activityId
  if (index > lastUser) return activityId
  return null
}

export function applyOpenAssistantStreamingChrome(input: {
  messages: ChatMessage[]
  activityStreamingId: string | null
  turnActive: boolean
  submitting: boolean
  /**
   * Activity still has non-terminal assistant/tool rows on the open turn.
   * When omitted, derived from activityStreamingId + open-host terminal state.
   */
  contentInFlight?: boolean
}): {
  messages: ChatMessage[]
  streamingMessageId: string | null
  isStreaming: boolean
  turnBusy: boolean
} {
  let messages = input.messages
  const turnOpen = input.turnActive || input.submitting
  const openAssistant = turnOpen ? findOpenAssistantHost(messages) : null
  const openAssistantId = openAssistant ? messageIdOf(openAssistant) || null : null
  const openIsTerminal =
    openAssistant != null && isTerminalChatAssistant(openAssistant)

  // Pre-first-token: no assistant host yet → content still "in flight".
  // After a terminal reply with no Activity in-flight → content done even if
  // Host turn is still open (Managed post-delta settle lag).
  const contentInFlight =
    turnOpen &&
    (input.contentInFlight === true ||
      input.activityStreamingId != null ||
      openAssistant == null ||
      !openIsTerminal)

  const streamingMessageId =
    turnOpen && contentInFlight
      ? resolveStreamingMessageId(
          messages,
          openIsTerminal ? null : openAssistantId,
          input.activityStreamingId,
        )
      : null

  // Never force completed hosts back to streaming just because the turn is open.
  if (
    turnOpen &&
    contentInFlight &&
    openAssistant &&
    !openIsTerminal &&
    (openAssistant as { __streamingStatus?: string }).__streamingStatus !==
      'streaming'
  ) {
    messages = messages.map((message) =>
      message === openAssistant
        ? { ...message, __streamingStatus: 'streaming' as const }
        : message,
    )
  }

  const isStreaming =
    (input.turnActive && contentInFlight) ||
    (input.submitting &&
      (streamingMessageId !== null || openAssistant == null))
  const turnBusy = turnOpen
  if (streamingMessageId) {
    messages = foldOpenTurnIntoLiveHost(messages, {
      liveMessageId: streamingMessageId,
      isStreaming,
    })
  }
  return {
    messages,
    streamingMessageId,
    isStreaming,
    turnBusy,
  }
}
