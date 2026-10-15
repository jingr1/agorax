import type { ChatMessage } from './types'

export function historyIndexOf(message: ChatMessage): number | null {
  const value = (message as { __historyIndex?: unknown }).__historyIndex
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null
}

/** Edit user message at historyIndex → keep everything strictly before it. */
export function keepCountForEdit(historyIndex: number): number {
  if (!Number.isInteger(historyIndex) || historyIndex < 0) {
    throw new Error('historyIndex must be a non-negative integer')
  }
  return historyIndex
}

/** Regenerate assistant at historyIndex → keep everything strictly before it. */
export function keepCountForRegenerate(historyIndex: number): number {
  return keepCountForEdit(historyIndex)
}

export function findLastUserMessage(
  messages: Array<ChatMessage>,
): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user') return message
  }
  return null
}
