/**
 * Quiet history reconcile: keep previous message object identity when the
 * server echo is equivalent (or poorer). Prevents React remount / scroll jump
 * when Hermes refetches after a turn or on the poll interval.
 *
 * Critical for long streaming turns: the server echo often arrives with tools
 * + final text but without the live reasoning trace. We must fold prior
 * thinking onto the matched assistant row instead of replacing it.
 */

import {
  mergeAssistantThinkingFromSource,
  thinkingTextFromContent,
} from './chat-message-parts'

type LooseMessage = {
  role?: string
  content?: unknown
  id?: unknown
  messageId?: unknown
  clientId?: unknown
  client_id?: unknown
  __optimisticId?: unknown
  status?: unknown
  text?: unknown
  __streamingThinking?: unknown
  [key: string]: unknown
}

function asMessage(value: unknown): LooseMessage | null {
  if (!value || typeof value !== 'object') return null
  return value as LooseMessage
}

function messageId(message: LooseMessage): string {
  for (const key of [
    'id',
    'messageId',
    'clientId',
    'client_id',
    '__optimisticId',
  ]) {
    const value = message[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Plain assistant/user text — never Array.prototype.toString on content parts. */
export function messagePlainText(message: LooseMessage): string {
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const rec = part as { type?: string; text?: unknown }
        if (rec.type === 'text' && typeof rec.text === 'string') return rec.text
        return ''
      })
      .join('\n')
      .trim()
  }
  if (typeof message.text === 'string') return message.text.trim()
  if (typeof message.content === 'string') return message.content.trim()
  return ''
}

function messageText(message: LooseMessage): string {
  return messagePlainText(message)
}

/** Long-stream safe: exact, prefix, or shared tail. */
export function textsLooselyMatch(a: string, b: string): boolean {
  const left = a.trim()
  const right = b.trim()
  if (!left || !right) return false
  if (left === right) return true
  if (left.startsWith(right) || right.startsWith(left)) return true
  const tailLen = 80
  if (left.length >= tailLen && right.length >= tailLen) {
    return left.slice(-tailLen) === right.slice(-tailLen)
  }
  return false
}

function matchKey(message: LooseMessage): string {
  const id = messageId(message)
  if (id) return `id:${id}`
  const role = typeof message.role === 'string' ? message.role : 'assistant'
  const text = messageText(message)
  if (text) return `text:${role}:${text.slice(-120)}`
  return ''
}

function isOptimistic(message: LooseMessage): boolean {
  if (typeof message.__optimisticId === 'string' && message.__optimisticId) {
    return true
  }
  const status = typeof message.status === 'string' ? message.status : ''
  return status === 'sending' || status === 'queued'
}

function toolCallCount(message: LooseMessage): number {
  const stream = Array.isArray(message.__streamToolCalls)
    ? message.__streamToolCalls.length
    : 0
  const embedded = Array.isArray(message.content)
    ? message.content.filter(
        (part) =>
          !!part &&
          typeof part === 'object' &&
          (part as { type?: string }).type === 'toolCall',
      ).length
    : 0
  return Math.max(stream, embedded)
}

function contentRicher(previous: LooseMessage, incoming: LooseMessage): boolean {
  const prevThinking = thinkingTextFromContent(previous.content).length
  const nextThinking = thinkingTextFromContent(incoming.content).length
  if (prevThinking > nextThinking) return true
  return toolCallCount(previous) > toolCallCount(incoming)
}

function sameVisibleContent(a: LooseMessage, b: LooseMessage): boolean {
  return (
    messageText(a) === messageText(b) &&
    thinkingTextFromContent(a.content) === thinkingTextFromContent(b.content)
  )
}

function isContentPart(
  part: unknown,
): part is { type?: string; id?: unknown; name?: unknown } {
  return !!part && typeof part === 'object'
}

/**
 * Keep the transcript the user already read. Stamp server ids and absorb any
 * extra tools/thinking from the echo — never replace streamed plain text with
 * a differently worded server rewrite of the same turn.
 *
 * When only the durable id changes, mutate `prior` in place and return the
 * same reference so React does not remount the bubble.
 */
export function mergePreferLiveAssistant(
  prior: LooseMessage,
  incoming: LooseMessage,
): LooseMessage {
  if (prior.role !== 'assistant' || incoming.role !== 'assistant') {
    return incoming
  }

  const priorText = messageText(prior)
  const incomingText = messageText(incoming)
  const liveMatches =
    priorText.length > 0 &&
    (incomingText.length === 0 || textsLooselyMatch(priorText, incomingText))

  // Server has a clearly different / longer answer we never showed — take it,
  // but keep any richer live thinking.
  if (!liveMatches && incomingText.length > priorText.length) {
    return mergeAssistantThinkingFromSource(incoming, prior)
  }

  const incomingId = messageId(incoming)
  if (incomingId && !messageId(prior)) {
    prior.id = incomingId
  }

  const withThinking = mergeAssistantThinkingFromSource(prior, incoming)
  if (toolCallCount(incoming) <= toolCallCount(withThinking)) {
    return withThinking
  }

  let kept: LooseMessage =
    withThinking === prior ? { ...prior } : { ...withThinking }

  const sourceTools = Array.isArray(incoming.__streamToolCalls)
    ? incoming.__streamToolCalls
    : []
  if (sourceTools.length > 0) {
    kept = {
      ...kept,
      __streamToolCalls: sourceTools,
      streamToolCalls: sourceTools,
    }
  }

  if (Array.isArray(incoming.content) && Array.isArray(kept.content)) {
    const existingKeys = new Set(
      kept.content
        .filter((part) => isContentPart(part) && part.type === 'toolCall')
        .map((part) =>
          String(
            (part as { id?: unknown }).id ??
              (part as { name?: unknown }).name ??
              '',
          ),
        )
        .filter(Boolean),
    )
    const extraTools = incoming.content.filter((part) => {
      if (!isContentPart(part) || part.type !== 'toolCall') return false
      const key = String(part.id ?? part.name ?? '')
      return key.length > 0 && !existingKeys.has(key)
    })
    if (extraTools.length > 0) {
      const thinkingParts = kept.content.filter(
        (part) =>
          isContentPart(part) &&
          (part.type === 'thinking' ||
            part.type === 'redacted_thinking' ||
            part.type === 'reasoning' ||
            part.type === 'reasoning_content'),
      )
      const existingToolParts = kept.content.filter(
        (part) => isContentPart(part) && part.type === 'toolCall',
      )
      const textParts = kept.content.filter(
        (part) => isContentPart(part) && part.type === 'text',
      )
      const otherParts = kept.content.filter(
        (part) =>
          !isContentPart(part) ||
          (part.type !== 'thinking' &&
            part.type !== 'redacted_thinking' &&
            part.type !== 'reasoning' &&
            part.type !== 'reasoning_content' &&
            part.type !== 'toolCall' &&
            part.type !== 'text'),
      )
      kept = {
        ...kept,
        content: [
          ...thinkingParts,
          ...existingToolParts,
          ...extraTools,
          ...textParts,
          ...otherParts,
        ],
      }
    }
  }

  return kept
}

function findPriorAssistant(
  previous: Array<LooseMessage>,
  message: LooseMessage,
  index: number,
  previousByKey: Map<string, LooseMessage>,
): LooseMessage | undefined {
  const key = matchKey(message)
  const byKey = key ? previousByKey.get(key) : undefined
  if (byKey) return byKey

  const text = messageText(message)
  if (text && message.role === 'assistant') {
    for (let i = previous.length - 1; i >= 0; i -= 1) {
      const candidate = previous[i]
      if (!candidate || candidate.role !== 'assistant') continue
      if (textsLooselyMatch(messageText(candidate), text)) return candidate
    }
  }

  if (
    index < previous.length &&
    previous[index]?.role === message.role &&
    textsLooselyMatch(messageText(previous[index]!), messageText(message))
  ) {
    return previous[index]
  }

  return undefined
}

/**
 * After a server echo replaces the live row, fold any richer prior thinking
 * onto the latest assistant. Covers the case where id/text match failed
 * (common after long streams) but the turn's reasoning was already shown.
 */
export function foldTrailingAssistantThinking<T>(
  messages: Array<T>,
  thinkingSource: {
    role?: string
    content?: unknown
    __streamingThinking?: unknown
  } | null,
): Array<T> {
  if (!thinkingSource) return messages
  const sourceThinking =
    thinkingTextFromContent(thinkingSource.content).trim() ||
    (typeof thinkingSource.__streamingThinking === 'string'
      ? thinkingSource.__streamingThinking.trim()
      : '')
  if (!sourceThinking) return messages

  let lastAssistantIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = asMessage(messages[i])
    if (row?.role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }
  if (lastAssistantIndex < 0) return messages

  const target = messages[lastAssistantIndex] as T & LooseMessage
  const merged = mergeAssistantThinkingFromSource(target, thinkingSource)
  if (merged === target) return messages
  const next = messages.slice()
  next[lastAssistantIndex] = merged as T
  return next
}

/**
 * Reconcile server history onto the current cache without thrashing identity.
 * - Keep previous objects when content is equivalent
 * - Prefer previous thinking when the server echo is thinner
 * - Take newer server text/tools but fold prior thinking back in
 * - Preserve unmatched optimistic / pending local rows
 */
export function reconcileHistoryMessages<T>(
  previousMessages: Array<T> | undefined,
  incomingMessages: Array<T> | undefined,
): Array<T> {
  const previous = (previousMessages ?? [])
    .map(asMessage)
    .filter((message): message is LooseMessage => !!message)
  const incoming = (incomingMessages ?? [])
    .map(asMessage)
    .filter((message): message is LooseMessage => !!message)

  if (incoming.length === 0) {
    return (previousMessages ?? []) as Array<T>
  }
  if (previous.length === 0) {
    return (incomingMessages ?? []) as Array<T>
  }

  const previousByKey = new Map<string, LooseMessage>()
  for (const message of previous) {
    const key = matchKey(message)
    if (key && !previousByKey.has(key)) previousByKey.set(key, message)
  }

  let reusedAll = incoming.length === previous.length
  const reconciled: Array<LooseMessage> = incoming.map((message, index) => {
    const prior = findPriorAssistant(previous, message, index, previousByKey)

    if (!prior) {
      reusedAll = false
      return message
    }

    const incomingId = messageId(message)
    // Stamp durable server id onto the existing object (no new reference).
    if (incomingId && !messageId(prior)) {
      prior.id = incomingId
    }

    // Always prefer the live transcript the user already saw when this is the
    // same turn. Post-turn history refetch used to swap in a differently
    // shaped server echo (tools-only / rewritten text) and felt like a reload.
    if (
      prior.role === 'assistant' &&
      message.role === 'assistant' &&
      (contentRicher(prior, message) ||
        sameVisibleContent(prior, message) ||
        textsLooselyMatch(messageText(prior), messageText(message)) ||
        messageText(prior).length > 0)
    ) {
      const kept = mergePreferLiveAssistant(prior, message)
      if (kept !== prior) reusedAll = false
      return kept
    }

    reusedAll = false
    return mergePreferLiveAssistant(prior, message)
  })

  // Keep local optimistic rows the server has not echoed yet.
  for (const message of previous) {
    if (!isOptimistic(message)) continue
    const key = matchKey(message)
    const already = key
      ? reconciled.some((row) => matchKey(row) === key)
      : reconciled.includes(message)
    if (!already) {
      reconciled.push(message)
      reusedAll = false
    }
  }

  // Last-resort: prior turn had thinking the server omitted and match failed.
  const lastPriorAssistant = [...previous]
    .reverse()
    .find((message) => message.role === 'assistant')
  const withThinking = foldTrailingAssistantThinking(
    reconciled,
    lastPriorAssistant ?? null,
  )
  if (withThinking !== reconciled) {
    reusedAll = false
  }

  if (reusedAll) {
    return previousMessages as Array<T>
  }
  return withThinking as Array<T>
}

export function reconcileHistoryResponse<
  T extends { messages?: Array<unknown> },
>(previous: T | undefined, incoming: T | undefined): T | undefined {
  if (!incoming) return previous
  if (!previous) return incoming
  const messages = reconcileHistoryMessages(
    previous.messages,
    incoming.messages,
  )
  if (messages === previous.messages) {
    return previous
  }
  return {
    ...incoming,
    messages,
  }
}
