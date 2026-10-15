/**
 * Shared open-turn streaming chrome (Hermes + managed).
 *
 * Prefers the projected list host (pending shell) so MessageItem keeps one id
 * across submit → first delta → settle.
 */

import { foldOpenTurnIntoLiveHost } from '@/lib/chat-turn-identity'
import type { ChatMessage } from '../types'

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
  const openAssistant = (() => {
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        lastUser = i
        break
      }
    }
    // Prefer send-time pending host so daemon/SSE rows fold into it
    // (managed turnIds are daemon UUIDs, not turn-<clientSubmitId>).
    let lastAssistant: ChatMessage | null = null
    for (let i = lastUser + 1; i < messages.length; i += 1) {
      const message = messages[i]
      if (message?.role !== 'assistant') continue
      lastAssistant = message
      const id =
        (typeof message.messageId === 'string' && message.messageId) ||
        (typeof message.id === 'string' && message.id) ||
        ''
      if (id.includes(':pending:')) return message
    }
    return lastAssistant
  })()
  const openAssistantId =
    (typeof openAssistant?.messageId === 'string' &&
      openAssistant.messageId.trim()) ||
    (typeof openAssistant?.id === 'string' && openAssistant.id.trim()) ||
    null
  const streamingMessageId =
    input.turnActive || input.submitting
      ? openAssistantId || input.activityStreamingId
      : null
  if (
    input.submitting &&
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
    input.turnActive ||
    (input.submitting && streamingMessageId !== null)
  const turnBusy = input.turnActive || input.submitting
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
