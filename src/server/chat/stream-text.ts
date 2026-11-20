
export const THINKING_TAG_NAMES = ['think', 'thinking', 'antThinking', 'thought'] as const

export const THINKING_OPEN_TAG =
  '<(?:thinking|antThinking|thought|think)\\b[^>]*(?:>[\\s\\S]*)?'

export function extractStreamingThinking(buffer: string): {
  displayText: string
  extractedThinking: string
  pendingThinking: string
  remainingBuffer: string
} {
  let extractedThinking = ''
  let rest = buffer

  for (const tag of THINKING_TAG_NAMES) {
    const complete = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi')
    rest = rest.replace(complete, (_match, body: string) => {
      if (body) extractedThinking += body
      return ''
    })
  }

  const unclosed = new RegExp(`${THINKING_OPEN_TAG}$`, 'i').exec(rest)
  let pendingThinking = ''
  let displayText = rest
  // Keep already-visible text in the buffer. fullReplace chunks are the whole
  // visible accumulation, not just the latest delta. Only the unclosed tag
  // stays attached so the next frame can finish it.
  let remainingBuffer = rest
  if (unclosed && unclosed.index >= 0) {
    displayText = rest.slice(0, unclosed.index)
    remainingBuffer = displayText + unclosed[0]
    const openEnd = unclosed[0].indexOf('>')
    if (openEnd >= 0) pendingThinking = unclosed[0].slice(openEnd + 1)
  }

  return { displayText, extractedThinking, pendingThinking, remainingBuffer }
}

export function mergeLiveThinking(closed: string, pending: string): string {
  const closedTrim = closed.trim()
  const pendingTrim = pending.trim()
  if (!pendingTrim) return closedTrim
  if (!closedTrim) return pendingTrim
  if (closedTrim.endsWith(pendingTrim)) return closedTrim
  return `${closedTrim}\n\n${pendingTrim}`
}

export function consumeInlineThinking(
  buffer: string,
  closedThinking: string,
): {
  buffer: string
  closedThinking: string
  liveThinking: string
  displayText: string
} {
  const split = extractStreamingThinking(buffer)
  const nextClosed = split.extractedThinking
    ? closedThinking + split.extractedThinking
    : closedThinking
  return {
    buffer: split.remainingBuffer,
    closedThinking: nextClosed,
    liveThinking: mergeLiveThinking(nextClosed, split.pendingThinking),
    displayText: split.displayText,
  }
}

export function takeAssistantCompletedContent(
  buffer: string,
  completed: string,
  sawDelta: boolean,
): string {
  if (!completed || sawDelta) return buffer
  return completed
}
