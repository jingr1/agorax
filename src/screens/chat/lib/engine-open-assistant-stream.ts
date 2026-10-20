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

/**
 * Resolve the durable open-turn assistant host already in the projected list.
 */
function findOpenAssistantHost(
  messages: ChatMessage[],
  turnOpen: boolean,
): ChatMessage | null {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  }

  let lastAssistantAfterUser: ChatMessage | null = null
  for (let i = lastUser + 1; i < messages.length; i += 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    lastAssistantAfterUser = message
  }
  if (lastAssistantAfterUser) return lastAssistantAfterUser

  if (!turnOpen) return null

  // Reclaim a streaming assistant that sorted above the latest user.
  for (let i = lastUser - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (
      (message as { __streamingStatus?: string }).__streamingStatus ===
      'streaming'
    ) {
      return message
    }
  }
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
  const openAssistant = findOpenAssistantHost(messages, turnOpen)
  const openAssistantId = openAssistant ? messageIdOf(openAssistant) || null : null
  const streamingMessageId = turnOpen
    ? openAssistantId || input.activityStreamingId
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
