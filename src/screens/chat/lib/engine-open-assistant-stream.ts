/**
 * Shared open-turn streaming chrome (Hermes + managed).
 *
 * Finds a durable assistant host already in the projected list (daemon/SSE
 * messageId). Does NOT invent `assistant:pending:…` messageIds — open-turn
 * face before the first durable assistant is transcript `processing:…`.
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
  const streamingMessageId = turnOpen
    ? resolveStreamingMessageId(
        messages,
        openAssistantId,
        input.activityStreamingId,
      )
    : null
  if (
    turnOpen &&
    openAssistant &&
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
    input.turnActive || (input.submitting && streamingMessageId !== null)
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
