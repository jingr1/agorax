import { textFromMessage } from '../utils'
import { isRetryableUserMessage } from '../chat-screen-utils'
import type { ChatAttachment, ChatMessage } from '../types'
import { stripQueuedWrapper } from '@/lib/strip-queued-wrapper'

export function normalizeMessageValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

export function messageFallbackSignature(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const timestamp = normalizeMessageValue(
    typeof raw.timestamp === 'number' ? String(raw.timestamp) : raw.timestamp,
  )

  const contentParts = Array.isArray(message.content)
    ? message.content
        .map((part: any) => {
          if (part.type === 'text') {
            return `t:${typeof part.text === 'string' ? part.text.trim() : ''}`
          }
          if (part.type === 'thinking') {
            return `th:${typeof part.thinking === 'string' ? part.thinking : ''}`
          }
          if (part.type === 'toolCall') {
            const toolPart = part
            return `tc:${toolPart.id ?? ''}:${toolPart.name ?? ''}`
          }
          return `p:${part.type ?? ''}`
        })
        .join('|')
    : ''

  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment: ChatAttachment | null) => {
          const name =
            typeof attachment?.name === 'string' ? attachment.name : ''
          const size =
            typeof attachment?.size === 'number' ? String(attachment.size) : ''
          const type =
            typeof attachment?.contentType === 'string'
              ? attachment.contentType
              : ''
          return `${name}:${size}:${type}`
        })
        .join('|')
    : ''

  return `${message.role ?? 'unknown'}:${timestamp}:${contentParts}:${attachments}`
}

export function getMessageClientId(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const directClientId = normalizeMessageValue(raw.clientId)
  if (directClientId) return directClientId

  const alternateClientId = normalizeMessageValue(raw.client_id)
  if (alternateClientId) return alternateClientId

  const optimisticId = normalizeMessageValue(raw.__optimisticId)
  if (optimisticId.startsWith('opt-')) {
    return optimisticId.slice(4)
  }
  return ''
}

export function getRetryMessageKey(message: ChatMessage): string {
  const clientId = getMessageClientId(message)
  if (clientId) return `client:${clientId}`

  const raw = message as Record<string, unknown>
  const optimisticId = normalizeMessageValue(raw.__optimisticId)
  if (optimisticId) return `optimistic:${optimisticId}`

  const messageId = normalizeMessageValue(raw.id)
  if (messageId) return `id:${messageId}`

  const timestamp = normalizeMessageValue(
    typeof raw.timestamp === 'number' ? String(raw.timestamp) : raw.timestamp,
  )
  const messageText = textFromMessage(message).trim()
  return `fallback:${message.role ?? 'unknown'}:${timestamp}:${messageText}`
}

export function isRetryableQueuedMessage(
  message: ChatMessage,
  mode: 'manual' | 'auto',
): boolean {
  return isRetryableUserMessage(message, mode)
}

export function getMessageRetryAttachments(
  message: ChatMessage,
): Array<ChatAttachment> {
  if (!Array.isArray(message.attachments)) return []
  return message.attachments.filter((attachment) => {
    return Boolean(attachment) && typeof attachment === 'object'
  })
}

export function getMessageStatusValue(message: ChatMessage): string {
  return normalizeMessageValue((message as Record<string, unknown>).status)
}

export function getMessageTimestampValue(message: ChatMessage): number | null {
  const raw = message as Record<string, unknown>
  const candidates = [
    raw.timestamp,
    raw.__createdAt,
    raw.createdAt,
    raw.created_at,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 1_000_000_000_000 ? candidate * 1000 : candidate
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (!Number.isNaN(parsed)) return parsed
    }
  }

  return null
}

export function getMessageAttachmentSignature(message: ChatMessage): string {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
    return ''
  }

  return message.attachments
    .map((attachment: ChatAttachment | null) => {
      const name = typeof attachment?.name === 'string' ? attachment.name : ''
      const size =
        typeof attachment?.size === 'number' ? String(attachment.size) : ''
      const type =
        typeof attachment?.contentType === 'string'
          ? attachment.contentType
          : ''
      return `${name}:${size}:${type}`
    })
    .sort()
    .join('|')
}

export function isOptimisticUserMessage(message: ChatMessage): boolean {
  const raw = message as Record<string, unknown>
  return (
    normalizeMessageValue(raw.__optimisticId).length > 0 ||
    ['sending', 'sent', 'done'].includes(getMessageStatusValue(message))
  )
}

export function shouldCollapseTextDuplicate(
  existing: ChatMessage,
  candidate: ChatMessage,
): boolean {
  if (existing.role !== candidate.role) return false

  if (candidate.role === 'assistant') {
    return true
  }

  if (candidate.role !== 'user') return false

  const existingTs = getMessageTimestampValue(existing)
  const candidateTs = getMessageTimestampValue(candidate)
  if (existingTs !== null && candidateTs !== null) {
    if (Math.abs(existingTs - candidateTs) > 15_000) return false
  }

  // Collapse same-turn user duplicates even after the optimistic marker has been
  // cleared. The send path can leave us with an optimistic local message plus a
  // confirmed/history copy after completion; requiring one side to still look
  // optimistic misses that handoff and leaves both visible.
  const existingSig = getMessageAttachmentSignature(existing)
  const candidateSig = getMessageAttachmentSignature(candidate)
  if (existingSig && candidateSig) {
    return existingSig === candidateSig
  }

  return true
}

export function stripQueuedWrapperFromUserMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'user') return message

  const text = textFromMessage(message)
  const cleanedText = stripQueuedWrapper(text)
  if (cleanedText === text) return message

  return {
    ...message,
    content: [{ type: 'text', text: cleanedText }],
    text: cleanedText,
    body: cleanedText,
    message: cleanedText,
  }
}
