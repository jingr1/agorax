/**
 * Shared chat message content normalization for Hermes history and managed ACP.
 *
 * Both runtimes must land on the same ChatMessage content shape so the UI
 * (MessageItem / TuiActivityCard) can treat thinking identically:
 *   content: [{ type: 'thinking', thinking }, { type: 'text', text }, ...]
 */

export type NormalizedTextPart = { type: 'text'; text: string }
export type NormalizedThinkingPart = {
  type: 'thinking' | 'redacted_thinking'
  thinking: string
}
export type NormalizedContentPart = NormalizedTextPart | NormalizedThinkingPart

const THINKING_TAG_NAMES = ['think', 'thinking', 'antThinking', 'thought'] as const

/**
 * Parse SQLite / gateway content into either a plain string or a structured
 * block array. Unlike the old flatten-to-text helper, thinking blocks are kept.
 */
export function parseStoredMessageContent(
  raw: unknown,
): string | Array<Record<string, unknown>> {
  if (raw == null) return ''
  if (Array.isArray(raw)) {
    return raw.filter(
      (block): block is Record<string, unknown> =>
        !!block && typeof block === 'object' && !Array.isArray(block),
    )
  }
  if (typeof raw !== 'string') return String(raw)

  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return raw

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (block): block is Record<string, unknown> =>
          !!block && typeof block === 'object' && !Array.isArray(block),
      )
    }
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>
      if (typeof rec.text === 'string') return rec.text
      if (typeof rec.content === 'string') return rec.content
    }
  } catch {
    // keep raw string
  }
  return raw
}

/** Plain-text preview from stored content (session lists, search snippets). */
export function storedMessageContentToText(raw: unknown): string {
  const parsed = parseStoredMessageContent(raw)
  if (typeof parsed === 'string') {
    return stripCompleteThinkingTags(parsed).trim()
  }
  return parsed
    .map((block) => {
      const type = typeof block.type === 'string' ? block.type : null
      if (type === 'thinking' || type === 'redacted_thinking') return ''
      if (type === 'text' || type == null) {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Normalize assistant/user content into ChatMessage content parts.
 * For assistants, also splits complete inline `<think>` / `<thinking>` tags
 * out of plain-text content so they land in Activity the same way managed
 * ACP `kind: reasoning` rows do.
 */
export function normalizeChatContentParts(
  raw: unknown,
  options?: { role?: string; extractInlineThinkingTags?: boolean },
): Array<NormalizedContentPart> {
  const role = options?.role ?? 'assistant'
  const extractInline =
    options?.extractInlineThinkingTags ?? role === 'assistant'

  const parsed = parseStoredMessageContent(raw)
  const parts: Array<NormalizedContentPart> = []

  if (typeof parsed === 'string') {
    if (!parsed) return parts
    if (extractInline) {
      const { text, thinking } = splitCompleteThinkingTags(parsed)
      if (thinking) {
        parts.push({ type: 'thinking', thinking })
      }
      if (text) {
        parts.push({ type: 'text', text })
      }
      return parts
    }
    parts.push({ type: 'text', text: parsed })
    return parts
  }

  let thinkingAcc = ''
  let textAcc = ''
  for (const block of parsed) {
    const type = typeof block.type === 'string' ? block.type : null
    // Hermes / OpenAI-style history may store reasoning as `reasoning`
    // (or `reasoning_content`) rather than `thinking`. Treat them the same
    // so Activity can show the trace after history refresh.
    if (
      type === 'thinking' ||
      type === 'redacted_thinking' ||
      type === 'reasoning' ||
      type === 'reasoning_content'
    ) {
      const thinking =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : typeof (block as { reasoning?: unknown }).reasoning === 'string'
              ? ((block as { reasoning: string }).reasoning)
              : ''
      if (thinking) thinkingAcc = appendThinking(thinkingAcc, thinking)
      continue
    }
    if (type === 'text' || type == null) {
      if (typeof block.text === 'string' && block.text) {
        textAcc = textAcc ? `${textAcc}\n${block.text}` : block.text
      }
    }
  }

  if (extractInline && textAcc) {
    const split = splitCompleteThinkingTags(textAcc)
    if (split.thinking) {
      thinkingAcc = appendThinking(thinkingAcc, split.thinking)
    }
    textAcc = split.text
  }

  if (thinkingAcc) {
    parts.push({ type: 'thinking', thinking: thinkingAcc })
  }
  if (textAcc) {
    parts.push({ type: 'text', text: textAcc })
  }
  return parts
}

export function thinkingContentFromText(
  text: string,
): NormalizedThinkingPart | null {
  const thinking = text.trim()
  if (!thinking) return null
  return { type: 'thinking', thinking }
}

export function thinkingTextFromPayload(
  payload: Record<string, unknown>,
): string {
  for (const key of [
    'text',
    'content',
    'message',
    'body',
    'displayPrompt',
    'title',
    'thinking',
  ]) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function thinkingTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const chunks: Array<string> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as Record<string, unknown>
    const type = rec.type
    if (
      type !== 'thinking' &&
      type !== 'redacted_thinking' &&
      type !== 'reasoning' &&
      type !== 'reasoning_content'
    ) {
      continue
    }
    const thinking =
      typeof rec.thinking === 'string'
        ? rec.thinking
        : typeof rec.text === 'string'
          ? rec.text
          : typeof rec.reasoning === 'string'
            ? rec.reasoning
            : ''
    if (thinking.trim()) chunks.push(thinking)
  }
  return chunks.join('\n\n')
}

/** Parse Hermes / OpenAI tool arguments (object or JSON string). */
export function normalizeToolCallArgs(
  args: unknown,
): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  if (typeof args !== 'string') return undefined
  const trimmed = args.trim()
  if (!trimmed) return undefined
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

export type StreamToolCallLike = {
  id?: string
  name?: string
  phase?: string
  args?: unknown
  preview?: string
  result?: string
}

function streamToolCallScore(entry: StreamToolCallLike): number {
  let score = 0
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name && name !== 'tool') score += 4
  const args = normalizeToolCallArgs(entry.args)
  if (args && Object.keys(args).length > 0) score += 3
  if (typeof entry.preview === 'string' && entry.preview.trim()) score += 2
  if (typeof entry.result === 'string' && entry.result.trim()) score += 2
  const phase = typeof entry.phase === 'string' ? entry.phase : ''
  if (phase === 'calling' || phase === 'running' || phase === 'start') {
    score += 1
  }
  return score
}

/** Merge live overlay + write-through tool rows without dropping args/name. */
export function mergeStreamToolCallRecords<
  T extends StreamToolCallLike,
>(overlay: Array<T>, durable: Array<T>): Array<T> {
  const byId = new Map<string, T>()

  const upsert = (entry: T, index: number) => {
    const rawId = typeof entry.id === 'string' ? entry.id.trim() : ''
    const key =
      rawId ||
      `${typeof entry.name === 'string' ? entry.name : 'tool'}-${index}`
    const prev = byId.get(key)
    if (!prev) {
      byId.set(key, {
        ...entry,
        id: rawId || key,
        args: normalizeToolCallArgs(entry.args) ?? entry.args,
      })
      return
    }
    const pick =
      streamToolCallScore(entry) >= streamToolCallScore(prev) ? entry : prev
    const other = pick === entry ? prev : entry
    byId.set(key, {
      ...other,
      ...pick,
      id: rawId || key,
      name:
        pick.name && pick.name !== 'tool'
          ? pick.name
          : other.name || pick.name || 'tool',
      args:
        normalizeToolCallArgs(pick.args) ??
        normalizeToolCallArgs(other.args) ??
        pick.args ??
        other.args,
      preview: pick.preview ?? other.preview,
      result: pick.result ?? other.result,
      phase: pick.phase ?? other.phase,
    })
  }

  durable.forEach(upsert)
  overlay.forEach(upsert)
  return Array.from(byId.values())
}

/** Read durable thinking already materialized on a ChatMessage row. */
export function thinkingTextFromMessage(message: {
  content?: unknown
  __streamingThinking?: unknown
}): string {
  const fromField =
    typeof message.__streamingThinking === 'string'
      ? message.__streamingThinking.trim()
      : ''
  const fromContent = thinkingTextFromContent(message.content).trim()
  if (!fromField) return fromContent
  if (!fromContent) return fromField
  return fromField.length >= fromContent.length ? fromField : fromContent
}

/**
 * Prefer source thinking when the target assistant row is missing it (or has a
 * shorter trace). Used when Hermes history refetch / mid-stream poll would
 * otherwise replace a realtime message that already carried thinking — managed
 * ACP keeps reasoning on the message row and never drops it on refresh.
 */
export function mergeAssistantThinkingFromSource<
  T extends {
    role?: string
    content?: unknown
    __streamingThinking?: unknown
  },
>(
  target: T,
  source: {
    role?: string
    content?: unknown
    __streamingThinking?: unknown
  },
): T {
  if (target.role && target.role !== 'assistant') return target
  if (source.role && source.role !== 'assistant') return target

  const sourceThinking =
    thinkingTextFromContent(source.content).trim() ||
    (typeof source.__streamingThinking === 'string'
      ? source.__streamingThinking.trim()
      : '')
  if (!sourceThinking) return target

  const targetThinking = thinkingTextFromContent(target.content).trim()
  if (targetThinking.length >= sourceThinking.length) return target

  const thinkingPart = thinkingContentFromText(sourceThinking)
  if (!thinkingPart) return target

  const existing = Array.isArray(target.content) ? [...target.content] : []
  const withoutThinking = existing.filter((part) => {
    if (!part || typeof part !== 'object') return true
    const type = (part as { type?: string }).type
    return type !== 'thinking' && type !== 'redacted_thinking'
  })

  return {
    ...target,
    content: [thinkingPart, ...withoutThinking],
  }
}

export type AssistantHostContentMessage = {
  role?: string
  content?: unknown
  __streamingStatus?: string
  __optimisticId?: unknown
  __streamToolCalls?: unknown
  __streamingThinking?: unknown
}

/**
 * Whether an assistant message should be kept in the transcript lane.
 * Matches managed ACP: text, thinking, or tool calls all count as host surface.
 *
 * Empty `__streamingStatus === 'streaming'` alone is NOT a host — live busy
 * UI mounts from turnBusy / TurnActivityHost, not from an empty stream row.
 */
export function assistantHasVisibleHostContent(
  message: AssistantHostContentMessage,
): boolean {
  if (message.__optimisticId && !Array.isArray(message.content)) return true
  // Keep the open-turn durable host in the transcript even before first
  // thinking/text — Working mounts above this row; filtering it out parked
  // Working at the list footer so reply text appeared "above then refreshed".
  if (message.__streamingStatus === 'streaming') return true
  if (
    Array.isArray(message.__streamToolCalls) &&
    message.__streamToolCalls.length > 0
  ) {
    return true
  }
  if (
    typeof message.__streamingThinking === 'string' &&
    message.__streamingThinking.trim().length > 0
  ) {
    return true
  }

  const content = Array.isArray(message.content) ? message.content : []
  if (content.length === 0) return false

  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as Record<string, unknown>
    if (
      rec.type === 'text' &&
      typeof rec.text === 'string' &&
      rec.text.trim().length > 0
    ) {
      return true
    }
    if (
      (rec.type === 'thinking' || rec.type === 'redacted_thinking') &&
      ((typeof rec.thinking === 'string' && rec.thinking.trim().length > 0) ||
        (typeof rec.text === 'string' && rec.text.trim().length > 0))
    ) {
      return true
    }
    if (
      rec.type === 'toolCall' ||
      rec.type === 'tool_use' ||
      rec.type === 'toolUse'
    ) {
      return true
    }
  }
  return false
}

/**
 * Thinking text or tool calls on an assistant row (Activity content).
 * Used by chat-store merge and waiting settlement — not as a busy gate.
 * Busy UI mounts from turnBusy / TurnActivityHost.
 */
export function assistantHasWorkingSurface(
  message: AssistantHostContentMessage,
): boolean {
  if (
    Array.isArray(message.__streamToolCalls) &&
    message.__streamToolCalls.length > 0
  ) {
    return true
  }
  if (
    typeof message.__streamingThinking === 'string' &&
    message.__streamingThinking.trim().length > 0
  ) {
    return true
  }

  const content = Array.isArray(message.content) ? message.content : []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as Record<string, unknown>
    if (
      (rec.type === 'thinking' || rec.type === 'redacted_thinking') &&
      ((typeof rec.thinking === 'string' && rec.thinking.trim().length > 0) ||
        (typeof rec.text === 'string' && rec.text.trim().length > 0))
    ) {
      return true
    }
    if (
      rec.type === 'toolCall' ||
      rec.type === 'tool_use' ||
      rec.type === 'toolUse'
    ) {
      return true
    }
  }
  return false
}

function appendThinking(existing: string, next: string): string {
  return existing ? `${existing}\n\n${next}` : next
}

/** Extract complete thinking tag pairs; leave unclosed tags as visible text. */
export function splitCompleteThinkingTags(raw: string): {
  text: string
  thinking: string
} {
  let text = String(raw ?? '')
  let thinking = ''
  if (!text) return { text: '', thinking: '' }

  for (const tag of THINKING_TAG_NAMES) {
    const complete = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi')
    text = text.replace(complete, (_match, body: string) => {
      if (body) thinking = appendThinking(thinking, body)
      return ''
    })
  }

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    thinking: thinking.trim(),
  }
}

function stripCompleteThinkingTags(raw: string): string {
  return splitCompleteThinkingTags(raw).text
}
