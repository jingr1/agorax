/**
 * Tutti-aligned chat turn identity helpers shared by Hermes write-through
 * and (conceptually) managed-agent messageId rows.
 *
 * See docs/hermes-native-bridge.md §2.
 */

import { normalizeToolCallArgs } from './chat-message-parts'

export function assistantMessageIdForRun(
  runId: string | null | undefined,
  sessionKey: string,
  /**
   * Open-turn nonce (clientSubmitId / turnId). Required when runId is absent —
   * session-only `assistant:pending:<session>` collided across turns.
   */
  turnKey?: string | null,
): string {
  const trimmedRun = typeof runId === 'string' ? runId.trim() : ''
  if (trimmedRun) return `assistant:${trimmedRun}`
  const trimmedSession = sessionKey.trim() || 'session'
  const trimmedTurn = typeof turnKey === 'string' ? turnKey.trim() : ''
  if (trimmedTurn) return `assistant:pending:${trimmedSession}:${trimmedTurn}`
  throw new Error(
    `assistantMessageIdForRun: turnKey required when runId is missing (session=${trimmedSession})`,
  )
}

export function readDurableMessageId(message: {
  id?: unknown
  messageId?: unknown
}): string {
  for (const key of ['messageId', 'id'] as const) {
    const value = message[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Presentation key for transcript rows. Prefer durable identity so growing
 * stream text does not remount the bubble (fingerprint keys caused reload UX).
 */
export function stableChatMessageKey(
  message: {
    id?: unknown
    messageId?: unknown
    __optimisticId?: unknown
    role?: unknown
    content?: unknown
  },
  index: number,
  textFromMessage: (message: { content?: unknown; role?: unknown }) => string,
): string {
  const durable = readDurableMessageId(message)
  if (durable) return durable

  if (
    typeof message.__optimisticId === 'string' &&
    message.__optimisticId.trim()
  ) {
    return message.__optimisticId.trim()
  }

  const role =
    typeof message.role === 'string' && message.role.trim()
      ? message.role.trim()
      : 'assistant'
  const text = textFromMessage(message).trim()
  if (role === 'assistant' && text.length > 0) {
    return `assistant-fp:${djb2(`${text.length}:${text.slice(0, 160)}`)}`
  }
  if (text.length > 0) {
    return `${role}-fp:${djb2(text.slice(0, 120))}-${index}`
  }
  return `${role}-idx:${index}`
}

function djb2(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

export type LiveAssistantProjection = {
  messageId: string
  runId: string | null
  text: string
  thinking: string
  toolCalls: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
    preview?: string
    result?: string
  }>
  streaming: boolean
  timestamp: number
}

/**
 * Build the single write-through assistant row for a live turn.
 * Same shape managed ACP keeps on one messageId across delta → settle.
 */
export function projectLiveAssistantMessage(
  projection: LiveAssistantProjection,
): {
  id: string
  messageId: string
  role: 'assistant'
  content: Array<Record<string, unknown>>
  timestamp: number
  runId: string | null
  __streamingStatus: 'streaming' | 'complete'
  __streamingText: string
  __streamingThinking: string
  __streamToolCalls: LiveAssistantProjection['toolCalls']
} {
  const content: Array<Record<string, unknown>> = []
  const thinking = projection.thinking.trim()
  if (thinking) {
    content.push({ type: 'thinking', thinking })
  }
  for (const toolCall of projection.toolCalls) {
    const args = normalizeToolCallArgs(toolCall.args)
    content.push({
      type: 'toolCall',
      id: toolCall.id,
      name: toolCall.name,
      arguments: args,
    })
  }
  const text = projection.text.trim()
  if (text) {
    content.push({ type: 'text', text })
  }

  return {
    id: projection.messageId,
    messageId: projection.messageId,
    role: 'assistant',
    content,
    timestamp: projection.timestamp,
    runId: projection.runId,
    __streamingStatus: projection.streaming ? 'streaming' : 'complete',
    __streamingText: projection.text,
    __streamingThinking: projection.thinking,
    __streamToolCalls: projection.toolCalls,
  }
}

/**
 * Upsert by durable messageId. Replaces the same row in place — never appends
 * a second assistant for the same turn.
 *
 * When `anchorAfterLastUser` is set (live write-through), the row is always
 * placed immediately after the latest user message so mid-turn narration cannot
 * paint above the prompt that triggered it.
 */
export function upsertMessageByDurableId<T extends { role?: string }>(
  messages: Array<T>,
  next: T & { id?: unknown; messageId?: unknown },
  options?: { anchorAfterLastUser?: boolean },
): Array<T> {
  const nextId = readDurableMessageId(next)
  if (!options?.anchorAfterLastUser) {
    if (!nextId) return [...messages, next]
    const index = messages.findIndex(
      (message) =>
        readDurableMessageId(message as { id?: unknown; messageId?: unknown }) ===
        nextId,
    )
    if (index < 0) return [...messages, next]
    const copy = messages.slice()
    copy[index] = {
      ...messages[index],
      ...next,
    }
    return copy
  }

  const without = nextId
    ? messages.filter(
        (message) =>
          readDurableMessageId(
            message as { id?: unknown; messageId?: unknown },
          ) !== nextId,
      )
    : messages.slice()
  let lastUserIndex = -1
  for (let i = without.length - 1; i >= 0; i -= 1) {
    if (without[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }
  const insertAt = lastUserIndex >= 0 ? lastUserIndex + 1 : without.length
  return [
    ...without.slice(0, insertAt),
    next,
    ...without.slice(insertAt),
  ]
}

type FoldableAssistant = {
  role?: string
  id?: unknown
  messageId?: unknown
  content?: unknown
  __streamingStatus?: unknown
  __streamingText?: unknown
  __streamingThinking?: unknown
  __streamToolCalls?: unknown
  runId?: unknown
  timestamp?: unknown
}

function plainTextFromFoldable(message: FoldableAssistant): string {
  if (typeof message.__streamingText === 'string' && message.__streamingText.trim()) {
    return message.__streamingText.trim()
  }
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const rec = part as { type?: string; text?: unknown }
      if (rec.type === 'text' && typeof rec.text === 'string') return rec.text
      return ''
    })
    .join('\n')
    .trim()
}

function thinkingFromFoldable(message: FoldableAssistant): string {
  if (
    typeof message.__streamingThinking === 'string' &&
    message.__streamingThinking.trim()
  ) {
    return message.__streamingThinking.trim()
  }
  const content = Array.isArray(message.content) ? message.content : []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as { type?: string; thinking?: unknown; text?: unknown }
    if (
      rec.type === 'thinking' ||
      rec.type === 'redacted_thinking' ||
      rec.type === 'reasoning' ||
      rec.type === 'reasoning_content'
    ) {
      if (typeof rec.thinking === 'string' && rec.thinking.trim()) {
        return rec.thinking.trim()
      }
      if (typeof rec.text === 'string' && rec.text.trim()) {
        return rec.text.trim()
      }
    }
  }
  return ''
}

function toolCallsFromFoldable(
  message: FoldableAssistant,
): LiveAssistantProjection['toolCalls'] {
  if (Array.isArray(message.__streamToolCalls)) {
    return message.__streamToolCalls as LiveAssistantProjection['toolCalls']
  }
  const content = Array.isArray(message.content) ? message.content : []
  const tools: LiveAssistantProjection['toolCalls'] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const rec = part as {
      type?: string
      id?: unknown
      name?: unknown
      arguments?: unknown
      args?: unknown
      phase?: unknown
    }
    if (rec.type !== 'toolCall' && rec.type !== 'tool_use') continue
    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim()
        : `tool-${tools.length}`
    const name =
      typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'tool'
    tools.push({
      id,
      name,
      phase:
        typeof rec.phase === 'string' && rec.phase.trim()
          ? rec.phase.trim()
          : 'complete',
      args: rec.arguments ?? rec.args,
    })
  }
  return tools
}

function mergeToolCalls(
  base: LiveAssistantProjection['toolCalls'],
  extra: LiveAssistantProjection['toolCalls'],
): LiveAssistantProjection['toolCalls'] {
  const byId = new Map<string, LiveAssistantProjection['toolCalls'][number]>()
  for (const tool of [...base, ...extra]) {
    const prev = byId.get(tool.id)
    if (!prev) {
      byId.set(tool.id, tool)
      continue
    }
    byId.set(tool.id, {
      ...prev,
      ...tool,
      args: tool.args ?? prev.args,
      preview: tool.preview ?? prev.preview,
      result: tool.result ?? prev.result,
    })
  }
  return Array.from(byId.values())
}

/**
 * While a turn is open, collapse every post-user assistant/tool fragment into
 * the single durable live host. Prevents history / message.started / subagent
 * echoes from painting settled bubbles beside the still-streaming parent.
 */
export function foldOpenTurnIntoLiveHost<T extends FoldableAssistant>(
  messages: Array<T>,
  options: {
    liveMessageId: string | null | undefined
    isStreaming: boolean
    streamingText?: string
    streamingThinking?: string
    toolCalls?: LiveAssistantProjection['toolCalls']
    runId?: string | null
    timestamp?: number
  },
): Array<T> {
  // Fold whenever a durable live id is known — including the just-settled
  // frame. Gating on `isStreaming` used to drop the fold on settle and
  // re-expand mid-turn orphans beside the host (transcript jump).
  const liveId =
    typeof options.liveMessageId === 'string' && options.liveMessageId.trim()
      ? options.liveMessageId.trim()
      : ''
  if (!liveId) return messages

  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }

  // Pull a misplaced live host out of the pre-user head. Otherwise an early
  // write-through row stays above the prompt and fold appends a second copy.
  const head: Array<T> = []
  const pulledFromHead: Array<T> = []
  const headEnd = lastUserIndex >= 0 ? lastUserIndex + 1 : 0
  for (let i = 0; i < headEnd; i += 1) {
    const message = messages[i]!
    const id = readDurableMessageId(message)
    const isLive =
      id === liveId || message.__streamingStatus === 'streaming'
    if (isLive && message.role === 'assistant') {
      pulledFromHead.push(message)
      continue
    }
    head.push(message)
  }

  const tail =
    lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages.slice()
  const openTurn = [...pulledFromHead, ...tail]

  if (openTurn.length === 0) {
    const projected = projectLiveAssistantMessage({
      messageId: liveId,
      runId: options.runId ?? null,
      text: options.streamingText ?? '',
      thinking: options.streamingThinking ?? '',
      toolCalls: options.toolCalls ?? [],
      streaming: options.isStreaming,
      timestamp: options.timestamp ?? Date.now(),
    })
    return [...head, projected as unknown as T]
  }

  let live: T | null = null
  const orphans: Array<T> = []
  for (const message of openTurn) {
    const id = readDurableMessageId(message)
    const isLive =
      id === liveId || message.__streamingStatus === 'streaming'
    if (isLive && !live) {
      live = message
      continue
    }
    if (
      message.role === 'assistant' ||
      message.role === 'tool' ||
      message.role === 'toolResult'
    ) {
      orphans.push(message)
      continue
    }
    orphans.push(message)
  }

  let text = (options.streamingText ?? '').trim() || (live ? plainTextFromFoldable(live) : '')
  let thinking =
    (options.streamingThinking ?? '').trim() ||
    (live ? thinkingFromFoldable(live) : '')
  let tools = options.toolCalls ? [...options.toolCalls] : []
  if (live) {
    tools = mergeToolCalls(tools, toolCallsFromFoldable(live))
    if (!text) text = plainTextFromFoldable(live)
    if (!thinking) thinking = thinkingFromFoldable(live)
  }

  for (const orphan of orphans) {
    if (orphan.role !== 'assistant' && orphan.role !== 'tool' && orphan.role !== 'toolResult') {
      continue
    }
    tools = mergeToolCalls(tools, toolCallsFromFoldable(orphan))
    const orphanText = plainTextFromFoldable(orphan)
    if (orphanText) {
      if (!text) text = orphanText
      else if (text.startsWith(orphanText) || orphanText.startsWith(text)) {
        if (orphanText.length > text.length) text = orphanText
      } else if (!text.includes(orphanText) && orphanText.length > text.length) {
        // Prefer the longer mid-turn narration already shown; avoid dual bubbles.
        text = orphanText.length >= text.length ? orphanText : text
      }
    }
    const orphanThinking = thinkingFromFoldable(orphan)
    if (orphanThinking && orphanThinking.length > thinking.length) {
      thinking = orphanThinking
    }
  }

  const projected = projectLiveAssistantMessage({
    messageId: liveId,
    runId:
      options.runId ??
      (live && typeof live.runId === 'string' ? live.runId : null),
    text,
    thinking,
    toolCalls: tools,
    streaming: options.isStreaming,
    timestamp:
      options.timestamp ??
      (live && typeof live.timestamp === 'number' ? live.timestamp : Date.now()),
  })

  // Preserve non-assistant/tool rows that somehow sat in the open turn (rare).
  const preserved = orphans.filter(
    (message) =>
      message.role !== 'assistant' &&
      message.role !== 'tool' &&
      message.role !== 'toolResult',
  )

  return [...head, projected as unknown as T, ...preserved]
}

/**
 * When two assistants share the same visible text, keep the live durable host.
 * Settled history echoes must not win the dedup race and force a second append.
 */
export function preferLiveAssistantOnCollision<T extends FoldableAssistant>(
  existing: T,
  candidate: T,
  liveMessageId?: string | null,
): T {
  const liveId =
    typeof liveMessageId === 'string' && liveMessageId.trim()
      ? liveMessageId.trim()
      : ''
  const existingLive =
    existing.__streamingStatus === 'streaming' ||
    (liveId.length > 0 && readDurableMessageId(existing) === liveId)
  const candidateLive =
    candidate.__streamingStatus === 'streaming' ||
    (liveId.length > 0 && readDurableMessageId(candidate) === liveId)
  if (candidateLive && !existingLive) return candidate
  if (existingLive && !candidateLive) return existing

  const existingTools = toolCallsFromFoldable(existing).length
  const candidateTools = toolCallsFromFoldable(candidate).length
  if (candidateTools > existingTools) return candidate
  return existing
}
