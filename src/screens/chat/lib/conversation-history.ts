import { textFromMessage } from '../utils'
import type { ChatMessage } from '../types'

export type PortableHistoryMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

export function isImageMimeType(value: unknown): boolean {
  const normalized = normalizeMimeType(value)
  return normalized.startsWith('image/')
}

export function readDataUrlMimeType(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = /^data:([^;,]+)[^,]*,/i.exec(value.trim())
  return match?.[1]?.trim().toLowerCase() || ''
}

export function stripDataUrlPrefix(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.toLowerCase().startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

export function getPortableHistoryContent(message: ChatMessage): string {
  const text = textFromMessage(message).trim()
  if (text) return text
  if (
    message.role === 'user' &&
    Array.isArray(message.attachments) &&
    message.attachments.length > 0
  ) {
    return 'Please review the attached content.'
  }
  return ''
}

export function buildPortableHistory(
  messages: Array<ChatMessage>,
): Array<PortableHistoryMessage> {
  return messages
    .filter(
      (
        message,
      ): message is ChatMessage & { role: 'user' | 'assistant' | 'system' } =>
        message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'system',
    )
    .filter((message) => (message as any).__streamingStatus !== 'streaming')
    .map((message) => {
      const content = getPortableHistoryContent(message)
      if (!content) return null
      return {
        role: message.role,
        content,
      }
    })
    .filter((message): message is PortableHistoryMessage => message !== null)
    .slice(-20)
}
