import { create } from 'zustand'
import {
  assistantHasVisibleHostContent,
  assistantHasWorkingSurface,
  mergeAssistantThinkingFromSource,
  normalizeToolCallArgs,
  thinkingTextFromMessage,
} from '../lib/chat-message-parts'
import {
  assistantMessageIdForRun,
  foldOpenTurnIntoLiveHost,
  projectLiveAssistantMessage,
  upsertMessageByDurableId,
} from '../lib/chat-turn-identity'
import type {
  ChatMessage,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
} from '../screens/chat/types'

let _streamingPersistTimer: ReturnType<typeof setTimeout> | null = null

export type ChatStreamEvent =
  | {
      type: 'message'
      message: ChatMessage
      sessionKey: string
      runId?: string
      transport?: 'chat-events' | 'send-stream'
    }
  | {
      type: 'chunk'
      text: string
      runId?: string
      sessionKey: string
      fullReplace?: boolean
      transport?: 'chat-events' | 'send-stream'
    }
  | {
      type: 'thinking'
      text: string
      runId?: string
      sessionKey: string
      transport?: 'chat-events' | 'send-stream'
    }
  | {
      type: 'tool'
      phase: string
      name: string
      toolCallId?: string
      args?: unknown
      preview?: string
      result?: string
      runId?: string
      sessionKey: string
      transport?: 'chat-events' | 'send-stream'
    }
  | {
      type: 'done'
      state: string
      errorMessage?: string
      runId?: string
      sessionKey: string
      message?: ChatMessage
      transport?: 'chat-events' | 'send-stream'
    }
  | {
      type: 'user_message'
      message: ChatMessage
      sessionKey: string
      source?: string
      runId?: string
      transport?: 'chat-events' | 'send-stream'
    }
  | {
      type: 'status' | 'lifecycle'
      text: string
      sessionKey: string
      runId?: string
      transport?: 'chat-events' | 'send-stream'
    }

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export type StreamingState = {
  /** Durable Tutti-style identity for the live assistant row. */
  messageId: string | null
  runId: string | null
  text: string
  thinking: string
  lifecycleEvents: Array<{
    text: string
    emoji: string
    timestamp: number
    isError: boolean
  }>
  toolCalls: Array<{
    id: string
    name: string
    phase: string
    args?: unknown
    preview?: string
    result?: string
  }>
}

type ChatState = {
  connectionState: ConnectionState
  lastError: string | null
  /** Messages received via real-time stream, keyed by sessionKey */
  realtimeMessages: Map<string, Array<ChatMessage>>
  /** Current streaming state per session */
  streamingState: Map<string, StreamingState>
  /** Timestamp of last received event */
  lastEventAt: number
  /**
   * RunIds currently being handled by send-stream (the active send SSE).
   * Server-side dedup is the primary defense. This client-side set remains as
   * a fallback in case a stale event slips through after transport issues.
   */
  sendStreamRunIds: Set<string>

  // Actions
  setConnectionState: (state: ConnectionState, error?: string) => void
  processEvent: (event: ChatStreamEvent) => void
  getRealtimeMessages: (sessionKey: string) => Array<ChatMessage>
  getStreamingState: (sessionKey: string) => StreamingState | null
  clearSession: (sessionKey: string) => void
  clearRealtimeBuffer: (sessionKey: string) => void
  clearStreamingSession: (sessionKey: string) => void
  /**
   * Seed a turn-scoped durable messageId before the first SSE frame so chunks
   * never fall back to `assistant:pending:<session>` (cross-turn collision).
   */
  beginStreamingTurn: (input: {
    sessionKey: string
    messageId: string
    runId?: string | null
  }) => void
  clearAllStreaming: () => void
  mergeHistoryMessages: (
    sessionKey: string,
    historyMessages: Array<ChatMessage>,
  ) => Array<ChatMessage>
  /** Register a runId as being handled by send-stream — chat-events will skip it */
  registerSendStreamRun: (runId: string) => void
  /** Unregister a runId when send-stream completes */
  unregisterSendStreamRun: (runId: string) => void
  /** Check if a runId is being handled by send-stream */
  isSendStreamRun: (runId: string | undefined) => boolean

  /** Sessions currently waiting for a response — survives component unmount */
  waitingSessionKeys: Set<string>
  waitingSessionMeta: Record<string, { since: number; runId: string | null }>
  /** Mark a session as waiting for a response */
  setSessionWaiting: (sessionKey: string, runId?: string | null) => void
  /** Clear waiting state for a session */
  clearSessionWaiting: (sessionKey: string) => void
  /** Check if a session is waiting for a response */
  isSessionWaiting: (sessionKey: string) => boolean

  /** Last activity description from heartbeat SSE — empty-gap TurnActivityHost
   *  and research/compact ThinkingBubble. */
  heartbeatActivity: string | null
  setHeartbeatActivity: (activity: string | null) => void
}

const createEmptyStreamingState = (): StreamingState => ({
  messageId: null,
  runId: null,
  text: '',
  thinking: '',
  lifecycleEvents: [],
  toolCalls: [],
})

function withDurableStreamingIdentity(
  prev: StreamingState,
  sessionKey: string,
  runId?: string,
  turnKey?: string | null,
): StreamingState {
  const nextRunId = runId ?? prev.runId
  // Prefer an already-seeded turn-scoped messageId. Never invent a session-only
  // pending id when a turnKey is available — that collided across turns and
  // wrote the new reply into the previous settled bubble.
  const messageId =
    prev.messageId ??
    assistantMessageIdForRun(nextRunId, sessionKey, turnKey)
  return {
    ...prev,
    runId: nextRunId,
    messageId,
  }
}

/**
 * Write-through: mirror streamingState onto one realtime assistant row with a
 * stable messageId (Tutti contract). UI and history merge read this same row.
 */
function syncLiveAssistantRow(
  realtimeMessages: Map<string, Array<ChatMessage>>,
  sessionKey: string,
  streaming: StreamingState,
  options: { streaming: boolean; timestamp: number },
): Map<string, Array<ChatMessage>> {
  if (!streaming.messageId) return realtimeMessages
  const projected = projectLiveAssistantMessage({
    messageId: streaming.messageId,
    runId: streaming.runId,
    text: streaming.text,
    thinking: streaming.thinking,
    toolCalls: streaming.toolCalls,
    streaming: options.streaming,
    timestamp: options.timestamp,
  })
  const messages = new Map(realtimeMessages)
  const sessionMessages = messages.get(sessionKey) ?? []
  messages.set(
    sessionKey,
    upsertMessageByDurableId(
      sessionMessages,
      projected as unknown as ChatMessage,
      { anchorAfterLastUser: true },
    ),
  )
  return messages
}

function persistStreamingState(
  sessionKey: string,
  state: StreamingState,
): void {
  if (typeof sessionStorage === 'undefined') return
  if (_streamingPersistTimer) clearTimeout(_streamingPersistTimer)
  _streamingPersistTimer = setTimeout(() => {
    sessionStorage.setItem(
      `claude_streaming_${sessionKey}`,
      JSON.stringify({ ...state, _savedAt: Date.now() }),
    )
  }, 500)
}

export function restoreStreamingState(
  sessionKey: string,
): StreamingState | null {
  if (typeof sessionStorage === 'undefined') return null

  const storageKey = `claude_streaming_${sessionKey}`
  const raw = sessionStorage.getItem(storageKey)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as StreamingState & { _savedAt?: unknown }
    const savedAt =
      typeof parsed._savedAt === 'number' && Number.isFinite(parsed._savedAt)
        ? parsed._savedAt
        : null

    if (!savedAt || Date.now() - savedAt > 60_000) {
      sessionStorage.removeItem(storageKey)
      return null
    }

    const { _savedAt, ...streamingState } = parsed
    return streamingState
  } catch {
    sessionStorage.removeItem(storageKey)
    return null
  }
}

const RECOVERY_MSG_PREFIX = 'claude_recovery_msg_'
const RECOVERY_MSG_TTL_MS = 5 * 60 * 1000

export function persistRecoveryMessage(
  sessionKey: string,
  message: ChatMessage,
): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(
      `${RECOVERY_MSG_PREFIX}${sessionKey}`,
      JSON.stringify({ message, storedAt: Date.now() }),
    )
  } catch {
    // Ignore storage write failures (quota, private mode, etc.).
  }
}

export function readRecoveryMessage(sessionKey: string): ChatMessage | null {
  if (typeof sessionStorage === 'undefined') return null
  const key = `${RECOVERY_MSG_PREFIX}${sessionKey}`
  const raw = sessionStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      message?: ChatMessage
      storedAt?: number
    }
    if (!parsed.message) return null
    if (
      typeof parsed.storedAt !== 'number' ||
      Date.now() - parsed.storedAt > RECOVERY_MSG_TTL_MS
    ) {
      sessionStorage.removeItem(key)
      return null
    }
    return parsed.message
  } catch {
    sessionStorage.removeItem(key)
    return null
  }
}

export function clearRecoveryMessage(sessionKey: string): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(`${RECOVERY_MSG_PREFIX}${sessionKey}`)
}

const WAITING_TTL_MS = 120_000
const WAITING_STORAGE_PREFIX = 'claude_waiting_'

function persistWaitingState(
  sessionKey: string,
  meta: { since: number; runId: string | null },
): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(
    `${WAITING_STORAGE_PREFIX}${sessionKey}`,
    JSON.stringify(meta),
  )
}

function removeWaitingState(sessionKey: string): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(`${WAITING_STORAGE_PREFIX}${sessionKey}`)
}

function restoreWaitingSessions(): {
  keys: Set<string>
  meta: Record<string, { since: number; runId: string | null }>
} {
  const keys = new Set<string>()
  const meta: Record<string, { since: number; runId: string | null }> = {}
  if (typeof sessionStorage === 'undefined') return { keys, meta }

  const now = Date.now()
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const storageKey = sessionStorage.key(i)
    if (!storageKey || !storageKey.startsWith(WAITING_STORAGE_PREFIX)) continue
    const sessionKey = storageKey.slice(WAITING_STORAGE_PREFIX.length)
    try {
      const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? '')
      if (
        typeof parsed.since === 'number' &&
        now - parsed.since < WAITING_TTL_MS
      ) {
        keys.add(sessionKey)
        meta[sessionKey] = {
          since: parsed.since,
          runId: typeof parsed.runId === 'string' ? parsed.runId : null,
        }
      } else {
        sessionStorage.removeItem(storageKey)
      }
    } catch {
      sessionStorage.removeItem(storageKey)
    }
  }
  return { keys, meta }
}

let realtimeMessageSequence = 0

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Strip <final>...</final> wrapper tags that the server emits as a
 * streaming-completion sentinel in agent chunk events.
 *
 * The server sometimes wraps the last streaming chunk (or a standalone
 * assistant-message event that fires before the formal `state: 'final'` chat
 * event) in <final>…</final> tags.  When the subsequent clean `done` event
 * arrives, the dedup logic compares its text against the already-stored tagged
 * version — they don't match — so BOTH messages end up in realtimeMessages and
 * appear side-by-side in the UI.
 *
 * Stripping these tags at the store boundary (before storing or comparing)
 * ensures the two copies are treated as the same message regardless of whether
 * the server included the sentinel tags or not.
 */
function stripFinalTags(text: string): string {
  // <final>…</final>  — strip outer wrapper (case-insensitive, allows whitespace)
  let result = text
    .replace(/^\s*<final>\s*([\s\S]*?)\s*<\/final>\s*$/i, '$1')
    .trim()
  // P7: strip internal model tags that should never appear in rendered output.
  // Matches chat UI's rg/ig/ag stripping functions.
  // Respects code blocks — only strip tags outside of ``` fences.
  result = stripInternalTags(result)
  return result
}

/**
 * Strip internal model tags (<thinking>, <antThinking>, <thought>,
 * <parameter name="newText">, <relevant_memories>) that can leak into
 * displayed text. Only strips outside code blocks to avoid breaking code samples.
 * Mirrors the chat control UI's tag-stripping pipeline.
 */
export function stripInternalTags(text: string): string {
  // Split on code blocks to avoid stripping inside them.
  // Do not trim the prose slices: trimming glues headings/paragraphs onto
  // adjacent ``` fences (`### Heading\n``` ` → `### Heading``` `) and the
  // markdown parser then shows literal backticks instead of code blocks.
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part // inside code block — leave untouched
      return part
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<parameter name="newText">[\s\S]*?<\/antml:parameter>/gi, '')
        .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/gi, '')
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Thinking tag pairs the provider may inline into the assistant text stream.
 * Mirrors hermes-webui's `_thinkPairs` (plus `<thinking>` / `<antThinking>`
 * long forms) so reasoning is surfaced in the Activity panel instead of being
 * printed as visible message text.
 */
const THINKING_TAG_PAIRS: ReadonlyArray<{ open: string; close: string }> = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
  { open: '<antThinking>', close: '</antThinking>' },
  { open: '<thought>', close: '</thought>' },
]

type SplitInlineThinkingResult = {
  content: string
  reasoning: string
  inThinking: boolean
}

/**
 * Split inline thinking blocks out of a (possibly streaming) assistant text.
 *
 * Code-aware: thinking tags inside a ``` fence, an inline backtick span or an
 * indented code block are left visible. During streaming an unclosed opening
 * tag means "still thinking" — its body is held as reasoning and suppressed
 * from the visible content so partial thinking never flashes in the bubble.
 * Mirrors hermes-webui's `_extractInlineThinkingFromContent`.
 */
export function splitInlineThinking(
  raw: string,
  options?: { streaming?: boolean },
): SplitInlineThinkingResult {
  const streaming = options?.streaming ?? false
  const text = String(raw ?? '')
  if (!text) return { content: text, reasoning: '', inThinking: false }

  const visible: Array<string> = []
  const extracted: Array<string> = []
  let cursor = 0
  let index = 0
  let fence = ''
  let inBacktick = false
  let seenNonspace = false
  let leadingRemoved = false
  let inThinking = false

  while (index < text.length) {
    // Track markdown code state (fence + inline backtick).
    if (index > 0 && text[index - 1] === '\n') {
      if (text.startsWith('```', index) || text.startsWith('~~~', index)) {
        const marker = text.startsWith('```', index) ? '```' : '~~~'
        fence = fence === marker ? '' : (fence || marker)
        index += marker.length
        continue
      }
    }
    const ch = text[index]
    if (!fence && ch === '`') inBacktick = !inBacktick
    const inCode = !!fence || inBacktick

    if (!inCode) {
      // Exact thinking opener at this index?
      let pair: { open: string; close: string } | null = null
      for (const candidate of THINKING_TAG_PAIRS) {
        if (text.startsWith(candidate.open, index)) {
          pair = candidate
          break
        }
      }
      if (pair) {
        const closeIndex = text.indexOf(pair.close, index + pair.open.length)
        if (closeIndex === -1) {
          // Unclosed opener. A leading unclosed block is genuine thinking cut
          // off mid-thought; on the non-streaming render path an unclosed tag
          // after visible content is treated as a literal typed tag.
          const leading = !seenNonspace
          if (!streaming && !leading) break
          if (leading) leadingRemoved = true
          visible.push(text.slice(cursor, index))
          const partial = text.slice(index + pair.open.length)
          if (partial) extracted.push(partial)
          inThinking = true
          cursor = text.length
          index = text.length
          break
        }
        visible.push(text.slice(cursor, index))
        extracted.push(text.slice(index + pair.open.length, closeIndex))
        if (!seenNonspace) leadingRemoved = true
        seenNonspace = true
        index = closeIndex + pair.close.length
        cursor = index
        continue
      }
      if (streaming) {
        // Trailing partial opener ("...<thi") may be a forming block.
        let matchedPartial = false
        for (const candidate of THINKING_TAG_PAIRS) {
          const rest = text.slice(index)
          if (
            rest.length < candidate.open.length &&
            candidate.open.startsWith(rest)
          ) {
            if (!seenNonspace) leadingRemoved = true
            visible.push(text.slice(cursor, index))
            inThinking = true
            cursor = text.length
            index = text.length
            matchedPartial = true
            break
          }
        }
        if (matchedPartial || index >= text.length) break
      }
    }
    if (ch.trim() !== '') seenNonspace = true
    index++
  }
  if (cursor < text.length) visible.push(text.slice(cursor))

  const content = leadingRemoved
    ? visible.join('').replace(/^\s+/, '')
    : visible.join('')
  const reasoning = extracted
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
  return { content, reasoning, inThinking }
}

const LIFECYCLE_PREFIX_EMOJIS = ['⏳', '⚠️', '🔄', '🗜️', '❌'] as const

function parseLifecycleEvent(
  text: string,
  timestamp: number,
): {
  text: string
  emoji: string
  timestamp: number
  isError: boolean
} {
  const trimmed = text.trim()
  const matchedEmoji =
    LIFECYCLE_PREFIX_EMOJIS.find((emoji) => trimmed.startsWith(emoji)) ?? ''
  const normalizedText = matchedEmoji
    ? trimmed.slice(matchedEmoji.length).trimStart()
    : trimmed
  const lowerText = normalizedText.toLowerCase()
  const isError =
    matchedEmoji === '❌' ||
    matchedEmoji === '⚠️' ||
    lowerText.includes('error') ||
    lowerText.includes('failed')

  return {
    text: normalizedText || trimmed,
    emoji: matchedEmoji,
    timestamp,
    isError,
  }
}

/**
 * Return a copy of `msg` with <final>...</final> tags stripped from all text
 * content blocks.  Other content types (thinking, toolCall, etc.) are left
 * untouched.  If the message has no text content the original object is
 * returned as-is so we don't allocate unnecessarily.
 */
function stripFinalTagsFromMessage(msg: ChatMessage): ChatMessage {
  let modified = false
  const rawMessage = msg as Record<string, unknown>
  const nextMessage: ChatMessage & Record<string, unknown> = { ...msg }

  if (Array.isArray(msg.content)) {
    const nextContent = msg.content.map((part) => {
      if (part.type !== 'text') return part
      const raw = (part as any).text ?? ''
      const stripped = stripFinalTags(
        typeof raw === 'string' ? raw : String(raw),
      )
      if (stripped === raw) return part
      modified = true
      return { ...part, text: stripped }
    })
    nextMessage.content = nextContent as typeof msg.content
  }

  for (const key of ['text', 'body', 'message'] as const) {
    const value = rawMessage[key]
    if (typeof value !== 'string') continue
    const stripped = stripFinalTags(value)
    if (stripped === value) continue
    nextMessage[key] = stripped
    modified = true
  }

  if (!modified) return msg
  return nextMessage
}

function toolCallsFromChatMessage(
  message: ChatMessage,
): StreamingState['toolCalls'] {
  const embedded = (message as { __streamToolCalls?: unknown }).__streamToolCalls
  const embeddedTools = Array.isArray(embedded) ? embedded : []
  const contentTools = Array.isArray(message.content)
    ? message.content.filter((part) => {
        if (!part || typeof part !== 'object') return false
        const type = (part as { type?: string }).type
        return type === 'toolCall' || type === 'tool_use' || type === 'toolUse'
      })
    : []
  const source = embeddedTools.length > 0 ? embeddedTools : contentTools
  return source.map((entry, index) => {
    const rec = entry as {
      id?: unknown
      name?: unknown
      phase?: unknown
      args?: unknown
      arguments?: unknown
      preview?: unknown
      result?: unknown
    }
    const id =
      typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `tool-${index}`
    const name =
      typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'tool'
    return {
      id,
      name,
      phase: typeof rec.phase === 'string' && rec.phase.trim() ? rec.phase : 'complete',
      args: rec.args ?? rec.arguments,
      preview: typeof rec.preview === 'string' ? rec.preview : undefined,
      result: typeof rec.result === 'string' ? rec.result : undefined,
    }
  })
}

/**
 * A late `done` (only when streamingState still live — finishStream no longer
 * always re-upserts after SSE settle) runs after streaming
 * state was deleted. Seed from the durable row so that settle cannot replace
 * a Working card's thinking/tools with an empty projection.
 */
function streamingSeedFromDurableRow(
  messages: Array<ChatMessage> | undefined,
  messageId: string,
): Pick<StreamingState, 'text' | 'thinking' | 'toolCalls'> | null {
  if (!messages || !messageId) return null
  const row = messages.find((message) => getMessageId(message) === messageId)
  if (!row || row.role !== 'assistant') return null
  const text = extractMessageText(row)
  const thinking = thinkingTextFromMessage(row)
  const toolCalls = toolCallsFromChatMessage(row)
  if (!text && !thinking && toolCalls.length === 0) return null
  return { text, thinking, toolCalls }
}

function getMessageId(msg: ChatMessage | null | undefined): string | undefined {
  if (!msg) return undefined
  const id = (msg as { id?: string }).id
  if (typeof id === 'string' && id.trim().length > 0) return id
  const messageId = (msg as { messageId?: string }).messageId
  if (typeof messageId === 'string' && messageId.trim().length > 0)
    return messageId
  return undefined
}

function getClientNonce(msg: ChatMessage | null | undefined): string {
  if (!msg) return ''
  const raw = msg as Record<string, unknown>
  return (
    normalizeString(raw.clientId) ||
    normalizeString(raw.client_id) ||
    normalizeString(raw.nonce) ||
    normalizeString(raw.idempotencyKey)
  )
}

function getMessageEventTime(
  msg: ChatMessage | null | undefined,
): number | undefined {
  if (!msg) return undefined
  const raw = msg as Record<string, unknown>
  for (const key of ['createdAt', 'timestamp'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function getMessageReceiveTime(
  msg: ChatMessage | null | undefined,
): number | undefined {
  if (!msg) return undefined
  const value = (msg as Record<string, unknown>).__receiveTime
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getMessageHistoryIndex(
  msg: ChatMessage | null | undefined,
): number | undefined {
  if (!msg) return undefined
  const raw = msg as Record<string, unknown>
  const value = raw.__historyIndex ?? raw.historyIndex
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getMessageRealtimeSequence(
  msg: ChatMessage | null | undefined,
): number | undefined {
  if (!msg) return undefined
  const value = (msg as Record<string, unknown>).__realtimeSequence
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function hasToolCalls(msg: ChatMessage | null | undefined): boolean {
  if (!msg) return false
  if (Array.isArray(msg.content)) {
    const contentHasToolCalls = msg.content.some(
      (part) => part.type === 'toolCall',
    )
    if (contentHasToolCalls) return true
  }

  const raw = msg as Record<string, unknown>
  return (
    (Array.isArray(raw.streamToolCalls) && raw.streamToolCalls.length > 0) ||
    (Array.isArray(raw.__streamToolCalls) && raw.__streamToolCalls.length > 0)
  )
}

function getMessageChronologyRank(msg: ChatMessage): number {
  const role = normalizeString(msg.role).toLowerCase()
  if (role === 'user') return 0
  if (role === 'assistant' && hasToolCalls(msg)) return 1
  if (role === 'tool' || role === 'toolresult' || role === 'tool_result')
    return 2
  if (role === 'assistant') return 3
  return 4
}

function compareMessagesByTime(left: ChatMessage, right: ChatMessage): number {
  const leftTime = getMessageEventTime(left) ?? getMessageReceiveTime(left) ?? 0
  const rightTime =
    getMessageEventTime(right) ?? getMessageReceiveTime(right) ?? 0
  if (leftTime !== rightTime) return leftTime - rightTime

  const leftHistoryIndex = getMessageHistoryIndex(left)
  const rightHistoryIndex = getMessageHistoryIndex(right)
  if (
    leftHistoryIndex !== undefined &&
    rightHistoryIndex !== undefined &&
    leftHistoryIndex !== rightHistoryIndex
  ) {
    return leftHistoryIndex - rightHistoryIndex
  }

  const leftRank = getMessageChronologyRank(left)
  const rightRank = getMessageChronologyRank(right)
  if (leftRank !== rightRank) return leftRank - rightRank

  const leftRealtimeSequence = getMessageRealtimeSequence(left)
  const rightRealtimeSequence = getMessageRealtimeSequence(right)
  if (
    leftRealtimeSequence !== undefined &&
    rightRealtimeSequence !== undefined &&
    leftRealtimeSequence !== rightRealtimeSequence
  ) {
    return leftRealtimeSequence - rightRealtimeSequence
  }

  const leftId = getMessageId(left) ?? ''
  const rightId = getMessageId(right) ?? ''
  return leftId.localeCompare(rightId)
}

function sortMessagesChronologically(
  messages: Array<ChatMessage>,
): Array<ChatMessage> {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const byTime = compareMessagesByTime(left.message, right.message)
      if (byTime !== 0) return byTime
      return left.index - right.index
    })
    .map(({ message }) => message)
}

function isExternalInboundUserSource(source: unknown): boolean {
  const normalized = normalizeString(source).toLowerCase()
  return (
    normalized === 'webchat' ||
    normalized === 'signal' ||
    normalized === 'telegram'
  )
}

function getAttachmentSignature(msg: ChatMessage | null | undefined): string {
  if (!msg) return ''
  const attachments = Array.isArray((msg as any).attachments)
    ? ((msg as any).attachments as Array<Record<string, unknown>>)
    : []
  if (attachments.length === 0) return ''
  return attachments
    .map((attachment) => {
      return `${normalizeString(attachment.name)}:${String(attachment.size ?? '')}`
    })
    .sort()
    .join('|')
}

function isOptimisticUserCandidate(
  msg: ChatMessage | null | undefined,
): boolean {
  if (!msg || msg.role !== 'user') return false
  const raw = msg as Record<string, unknown>
  return (
    normalizeString(raw.__optimisticId).length > 0 ||
    ['sending', 'queued', 'sent', 'done'].includes(normalizeString(raw.status))
  )
}

function messageMultipartSignature(
  msg: ChatMessage | null | undefined,
): string {
  if (!msg) return ''
  let content = Array.isArray(msg.content)
    ? msg.content
        .map((part) => {
          if (part.type === 'text')
            return `t:${String((part as any).text ?? '').trim()}`
          if (part.type === 'thinking')
            return `h:${String((part as any).thinking ?? '').trim()}`
          if (part.type === 'toolCall')
            return `tc:${String((part as any).id ?? '')}:${String((part as any).name ?? '')}`
          return `p:${String((part as any).type ?? '')}`
        })
        .join('|')
    : ''
  // Fallback: if content array is empty/missing, check top-level text fields
  // so that legacy-format messages still produce a meaningful signature.
  if (!content) {
    const raw = msg as Record<string, unknown>
    for (const key of ['text', 'body', 'message']) {
      const val = raw[key]
      if (typeof val === 'string' && val.trim().length > 0) {
        content = `t:${stripFinalTags(val.trim())}`
        break
      }
    }
  }
  const attachments = Array.isArray((msg as any).attachments)
    ? (msg as any).attachments
        .map(
          (attachment: any) =>
            `${String(attachment?.name ?? '')}:${String(attachment?.size ?? '')}:${String(attachment?.contentType ?? '')}`,
        )
        .join('|')
    : ''
  return `${msg.role ?? 'unknown'}:${content}:${attachments}`
}

const _restoredWaiting = restoreWaitingSessions()

export const useChatStore = create<ChatState>((set, get) => ({
  connectionState: 'disconnected',
  lastError: null,
  realtimeMessages: new Map(),
  streamingState: new Map(),
  lastEventAt: 0,
  sendStreamRunIds: new Set(),
  waitingSessionKeys: _restoredWaiting.keys,
  waitingSessionMeta: _restoredWaiting.meta,
  heartbeatActivity: null,

  setConnectionState: (connectionState, error) => {
    set({ connectionState, lastError: error ?? null })
  },

  registerSendStreamRun: (runId) => {
    const next = new Set(get().sendStreamRunIds)
    next.add(runId)
    set({ sendStreamRunIds: next })
  },

  unregisterSendStreamRun: (runId) => {
    const next = new Set(get().sendStreamRunIds)
    next.delete(runId)
    set({ sendStreamRunIds: next })
  },

  isSendStreamRun: (runId) => {
    if (!runId) return false
    return get().sendStreamRunIds.has(runId)
  },

  setSessionWaiting: (sessionKey, runId) => {
    const meta = {
      since: get().waitingSessionMeta[sessionKey]?.since ?? Date.now(),
      runId: runId ?? null,
    }
    const nextKeys = new Set(get().waitingSessionKeys)
    nextKeys.add(sessionKey)
    const nextMeta = { ...get().waitingSessionMeta, [sessionKey]: meta }
    persistWaitingState(sessionKey, meta)
    set({ waitingSessionKeys: nextKeys, waitingSessionMeta: nextMeta })
  },

  clearSessionWaiting: (sessionKey) => {
    const nextKeys = new Set(get().waitingSessionKeys)
    nextKeys.delete(sessionKey)
    const { [sessionKey]: _, ...nextMeta } = get().waitingSessionMeta
    removeWaitingState(sessionKey)
    set({ waitingSessionKeys: nextKeys, waitingSessionMeta: nextMeta })
  },

  isSessionWaiting: (sessionKey) => {
    return get().waitingSessionKeys.has(sessionKey)
  },

  setHeartbeatActivity: (activity) => {
    set({ heartbeatActivity: activity })
  },

  processEvent: (event) => {
    const state = get()
    const sessionKey = event.sessionKey
    const now = Date.now()

    // Skip ALL events for runs being handled by send-stream.
    // send-stream is the authoritative handler for active sends — chat-events
    // fires the same events in parallel, causing duplicate messages.
    // Previously only covered chunk/thinking/tool/done — missing 'message'
    // was the root cause of the persistent duplication bug.
    if (
      event.transport !== 'send-stream' &&
      event.runId &&
      get().sendStreamRunIds.has(event.runId)
    ) {
      return
    }

    switch (event.type) {
      case 'message':
      case 'user_message': {
        // Filter internal system event messages that should never appear in chat.
        // These are pre-compaction flushes, heartbeat prompts, and similar
        // server-injected control messages — mirror the filter in use-chat-history.ts.
        if (event.message.role === 'user') {
          const rawText = extractMessageText(event.message)
          if (
            rawText.startsWith('Pre-compaction memory flush') ||
            rawText.includes('Store durable memories now') ||
            rawText.includes('APPEND new content only and do not overwrite') ||
            rawText.startsWith('A subagent task') ||
            rawText.startsWith('[Queued announce messages') ||
            rawText.includes('Summarize this naturally for the user') ||
            (rawText.includes('Stats: runtime') &&
              rawText.includes('sessionKey agent:'))
          ) {
            break
          }
        }

        const messages = new Map(state.realtimeMessages)
        const sessionMessages = [...(messages.get(sessionKey) ?? [])]
        const incomingReceiveTime = now

        // Strip <final>…</final> sentinel tags from assistant messages before
        // storing or comparing.  The server can emit a bare assistant-message
        // event (state=undefined) whose text is still wrapped in these tags,
        // and the subsequent clean `done` event then fails the dedup check
        // because the stored text differs from the final text.
        const normalizedMessage =
          event.message.role === 'assistant'
            ? stripFinalTagsFromMessage(event.message)
            : event.message

        const newId = getMessageId(normalizedMessage)
        const newClientNonce = getClientNonce(normalizedMessage)
        const newMultipartSignature =
          messageMultipartSignature(normalizedMessage)

        const optimisticIndexByNonce =
          newClientNonce.length > 0
            ? sessionMessages.findIndex((existing) => {
                if (existing.role !== normalizedMessage.role) return false
                const existingNonce = getClientNonce(existing)
                if (
                  existingNonce.length === 0 ||
                  existingNonce !== newClientNonce
                ) {
                  return false
                }
                return (
                  normalizeString((existing as any).status) === 'sending' ||
                  Boolean((existing as any).__optimisticId)
                )
              })
            : -1

        const optimisticIndex =
          optimisticIndexByNonce >= 0
            ? optimisticIndexByNonce
            : normalizedMessage.role === 'user'
              ? sessionMessages.findIndex((existing) => {
                  if (existing.role !== 'user') return false
                  if (!isOptimisticUserCandidate(existing)) return false
                  const existingText = extractMessageText(existing)
                  const incomingText = extractMessageText(normalizedMessage)
                  if (
                    existingText &&
                    incomingText &&
                    existingText === incomingText
                  ) {
                    return true
                  }
                  const existingAttachments = getAttachmentSignature(existing)
                  const incomingAttachments =
                    getAttachmentSignature(normalizedMessage)
                  return (
                    existingText.length === 0 &&
                    incomingText.length === 0 &&
                    existingAttachments.length > 0 &&
                    existingAttachments === incomingAttachments
                  )
                })
              : -1

        // Plain-text extraction for content-based dedup (catches identical
        // replies that arrive with different IDs from different channels).
        const newPlainText = extractMessageText(normalizedMessage)
        const isExternalInboundUser =
          normalizedMessage.role === 'user' &&
          isExternalInboundUserSource((event as any).source)
        const incomingEventTime =
          getMessageEventTime(normalizedMessage) ?? incomingReceiveTime

        const duplicateIndex = sessionMessages.findIndex((existing) => {
          if (existing.role !== normalizedMessage.role) return false
          const existingId = getMessageId(existing)
          if (newId && existingId && newId === existingId) return true

          const existingNonce = getClientNonce(existing)
          if (
            newClientNonce &&
            existingNonce &&
            newClientNonce === existingNonce
          ) {
            return true
          }

          if (
            newMultipartSignature.length > 0 &&
            newMultipartSignature === messageMultipartSignature(existing)
          ) {
            return true
          }

          // Content-text dedup: identical assistant text within the same
          // session should never appear twice, even if message IDs differ
          // (e.g. same reply routed from Telegram + Agorax).
          if (
            normalizedMessage.role === 'assistant' &&
            newPlainText.length > 20 &&
            newPlainText === extractMessageText(existing)
          ) {
            return true
          }

          return false
        })

        // Mark user messages from external sources
        const incomingMessage: ChatMessage = {
          ...normalizedMessage,
          __realtimeSource:
            event.type === 'user_message' ? (event as any).source : undefined,
          __receiveTime: incomingReceiveTime,
          __realtimeSequence: realtimeMessageSequence++,
          status: undefined,
        }

        if (optimisticIndex >= 0) {
          const optimisticMessage = sessionMessages[optimisticIndex]
          const incomingText = extractMessageText(incomingMessage)
          const optimisticText = extractMessageText(optimisticMessage)
          const incomingHasAttachments =
            Array.isArray((incomingMessage as any).attachments) &&
            (incomingMessage as any).attachments.length > 0
          const optimisticHasAttachments =
            Array.isArray((optimisticMessage as any).attachments) &&
            (optimisticMessage as any).attachments.length > 0

          sessionMessages[optimisticIndex] = {
            ...optimisticMessage,
            ...incomingMessage,
            content:
              incomingText.length > 0 || !optimisticText.length
                ? incomingMessage.content
                : optimisticMessage.content,
            attachments:
              incomingHasAttachments || !optimisticHasAttachments
                ? incomingMessage.attachments
                : optimisticMessage.attachments,
            __optimisticId: undefined,
            status: undefined,
          }
          messages.set(sessionKey, sortMessagesChronologically(sessionMessages))
          set({ realtimeMessages: messages, lastEventAt: now })
          break
        }

        const hasRecentExternalDuplicate =
          isExternalInboundUser &&
          newPlainText.length > 0 &&
          sessionMessages.some((existing) => {
            if (existing.role !== 'user') return false
            if (extractMessageText(existing) !== newPlainText) return false
            const existingEventTime =
              getMessageEventTime(existing) ?? getMessageReceiveTime(existing)
            if (existingEventTime === undefined) return false
            return Math.abs(incomingEventTime - existingEventTime) <= 10_000
          })

        if (hasRecentExternalDuplicate) {
          break
        }

        if (duplicateIndex === -1) {
          // Open turn already has a durable write-through host
          // (`assistant:<runId>` via chunk/tool). Gateway message.started /
          // mid-turn assistant echoes must not open a second bubble — that
          // painted settled text beside the still-streaming parent.
          const liveStreaming = state.streamingState.get(sessionKey)
          if (
            incomingMessage.role === 'assistant' &&
            liveStreaming?.messageId
          ) {
            break
          }

          // Multiple message.started events from the agent create distinct
          // realtime entries with empty content. Replace the previous empty
          // assistant message instead of appending — prevents "3 individual
          // messages then one final" bug where each tool phase looks like a
          // separate assistant bubble.
          if (
            incomingMessage.role === 'assistant' &&
            newPlainText.length === 0 &&
            sessionMessages.length > 0
          ) {
            const prevEmptyIdx = sessionMessages.reduce<number>(
              (found, m, idx) =>
                m.role === 'assistant' &&
                extractMessageText(m).length === 0 &&
                !assistantHasWorkingSurface(m)
                  ? idx
                  : found,
              -1,
            )
            if (prevEmptyIdx >= 0) {
              sessionMessages[prevEmptyIdx] = incomingMessage
              messages.set(
                sessionKey,
                sortMessagesChronologically(sessionMessages),
              )
              set({ realtimeMessages: messages, lastEventAt: now })
              break
            }
            // A thinking/tool row has no plain text. Do not open a second
            // empty assistant beside it — that replacement used to unmount
            // the Working card.
            if (
              sessionMessages.some(
                (message) =>
                  message.role === 'assistant' &&
                  assistantHasWorkingSurface(message),
              )
            ) {
              break
            }
          }
          sessionMessages.push(incomingMessage)
          messages.set(sessionKey, sortMessagesChronologically(sessionMessages))
          set({ realtimeMessages: messages, lastEventAt: now })
        }
        break
      }

      case 'chunk': {
        const streamingMap = new Map(state.streamingState)
        const prev = withDurableStreamingIdentity(
          streamingMap.get(sessionKey) ?? createEmptyStreamingState(),
          sessionKey,
          event.runId,
        )

        // Server usually strips thinking into dedicated events; still run a
        // client-side split so leaked <think>/<thinking> never prints in the
        // reply bubble (esp. when providers inline reasoning into text deltas).
        const rawChunk =
          event.fullReplace === false ? prev.text + event.text : event.text
        // Split before stripInternalTags — otherwise <think> is deleted and
        // never reaches Activity thinking.
        const split = splitInlineThinking(rawChunk, { streaming: true })
        // Prefer dedicated thinking-event text; only fold in newly extracted
        // leaked tags (avoid duplicating the same block under fullReplace).
        const extracted = split.reasoning.trim()
        const prevThinking = prev.thinking.trim()
        const mergedThinking = !extracted
          ? prev.thinking
          : !prevThinking
            ? extracted
            : prevThinking.includes(extracted)
              ? prev.thinking
              : extracted.includes(prevThinking)
                ? extracted
                : `${prev.thinking}\n\n${extracted}`
        const next: StreamingState = {
          ...prev,
          text: stripFinalTags(split.content),
          thinking: mergedThinking,
        }

        streamingMap.set(sessionKey, next)
        const realtimeMessages = syncLiveAssistantRow(
          state.realtimeMessages,
          sessionKey,
          next,
          { streaming: true, timestamp: now },
        )
        set({
          streamingState: streamingMap,
          realtimeMessages,
          lastEventAt: now,
        })
        persistStreamingState(sessionKey, next)

        break
      }

      case 'thinking': {
        const streamingMap = new Map(state.streamingState)
        const prev = withDurableStreamingIdentity(
          streamingMap.get(sessionKey) ?? createEmptyStreamingState(),
          sessionKey,
          event.runId,
        )
        const next: StreamingState = {
          ...prev,
          thinking: event.text,
        }

        streamingMap.set(sessionKey, next)
        const realtimeMessages = syncLiveAssistantRow(
          state.realtimeMessages,
          sessionKey,
          next,
          { streaming: true, timestamp: now },
        )
        set({
          streamingState: streamingMap,
          realtimeMessages,
          lastEventAt: now,
        })
        persistStreamingState(sessionKey, next)
        break
      }

      case 'status':
      case 'lifecycle': {
        const streamingMap = new Map(state.streamingState)
        const prev = withDurableStreamingIdentity(
          streamingMap.get(sessionKey) ?? createEmptyStreamingState(),
          sessionKey,
          event.runId,
        )
        const next: StreamingState = {
          ...prev,
          lifecycleEvents: [
            ...prev.lifecycleEvents,
            parseLifecycleEvent(event.text, now),
          ],
        }

        streamingMap.set(sessionKey, next)
        const realtimeMessages = syncLiveAssistantRow(
          state.realtimeMessages,
          sessionKey,
          next,
          { streaming: true, timestamp: now },
        )
        set({
          streamingState: streamingMap,
          realtimeMessages,
          lastEventAt: now,
        })
        persistStreamingState(sessionKey, next)
        break
      }

      case 'tool': {
        const streamingMap = new Map(state.streamingState)
        const prev = withDurableStreamingIdentity(
          streamingMap.get(sessionKey) ?? createEmptyStreamingState(),
          sessionKey,
          event.runId,
        )

        const toolCallId =
          event.toolCallId ??
          `${event.name || 'tool'}-${event.runId || sessionKey}-${prev.toolCalls.length}`
        const existingToolIndex = prev.toolCalls.findIndex(
          (tc) => tc.id === toolCallId,
        )

        const nextToolCalls = [...prev.toolCalls]

        const normalizedArgs =
          normalizeToolCallArgs(event.args) ??
          normalizeToolCallArgs(
            existingToolIndex >= 0
              ? nextToolCalls[existingToolIndex]?.args
              : undefined,
          )
        if (existingToolIndex >= 0) {
          nextToolCalls[existingToolIndex] = {
            ...nextToolCalls[existingToolIndex],
            phase: event.phase,
            name:
              event.name && event.name !== 'tool'
                ? event.name
                : nextToolCalls[existingToolIndex].name,
            args: normalizedArgs ?? nextToolCalls[existingToolIndex].args,
            preview:
              (event as any).preview ??
              nextToolCalls[existingToolIndex].preview,
            result:
              (event as any).result ?? nextToolCalls[existingToolIndex].result,
          }
        } else {
          // Create entry for ANY phase (complete, error, skill.loaded, artifact.created, etc.)
          // Events like skill.loaded arrive with phase 'complete' and no prior 'start' — create them too
          nextToolCalls.push({
            id: toolCallId,
            name: event.name,
            phase: event.phase,
            args: normalizedArgs ?? event.args,
            preview: (event as any).preview,
            result: (event as any).result,
          })
        }

        const next: StreamingState = {
          ...prev,
          toolCalls: nextToolCalls,
        }

        streamingMap.set(sessionKey, next)
        const realtimeMessages = syncLiveAssistantRow(
          state.realtimeMessages,
          sessionKey,
          next,
          { streaming: true, timestamp: now },
        )
        set({
          streamingState: streamingMap,
          realtimeMessages,
          lastEventAt: now,
        })
        persistStreamingState(sessionKey, next)
        break
      }

      case 'done': {
        // Tutti settle: same durable row flips to complete. Do not replace
        // live content with a differently shaped done.message echo.
        const streamingMap = new Map(state.streamingState)
        const hadLiveStream = streamingMap.has(sessionKey)
        const prev =
          streamingMap.get(sessionKey) ?? createEmptyStreamingState()
        const streaming = withDurableStreamingIdentity(
          prev,
          sessionKey,
          event.runId,
        )

        // Fold any late text from done.message without dropping live thinking.
        let settledStreaming = streaming
        if (!hadLiveStream && streaming.messageId) {
          const seeded = streamingSeedFromDurableRow(
            state.realtimeMessages.get(sessionKey),
            streaming.messageId,
          )
          if (seeded) {
            settledStreaming = {
              ...settledStreaming,
              text: settledStreaming.text.trim() ? settledStreaming.text : seeded.text,
              thinking: settledStreaming.thinking.trim()
                ? settledStreaming.thinking
                : seeded.thinking,
              toolCalls:
                settledStreaming.toolCalls.length > 0
                  ? settledStreaming.toolCalls
                  : seeded.toolCalls,
            }
          }
        }
        if (event.message) {
          const cleaned = ensureAssistantTextContent(
            stripFinalTagsFromMessage(event.message),
          )
          const doneText = extractMessageText(cleaned)
          if (doneText && doneText.length > settledStreaming.text.trim().length) {
            settledStreaming = {
              ...settledStreaming,
              text: stripFinalTags(doneText),
            }
          }
          if (!settledStreaming.thinking.trim()) {
            const doneThinking = mergeAssistantThinkingFromSource(
              { role: 'assistant', content: [] },
              cleaned,
            )
            const thinkingFromDone =
              typeof doneThinking.content === 'object' &&
              Array.isArray(doneThinking.content)
                ? (
                    doneThinking.content.find(
                      (part) =>
                        part &&
                        typeof part === 'object' &&
                        (part as { type?: string }).type === 'thinking',
                    ) as { thinking?: string } | undefined
                  )?.thinking
                : ''
            if (thinkingFromDone?.trim()) {
              settledStreaming = {
                ...settledStreaming,
                thinking: thinkingFromDone.trim(),
              }
            }
          }
        }

        const hasLiveContent =
          settledStreaming.text.trim().length > 0 ||
          settledStreaming.thinking.trim().length > 0 ||
          settledStreaming.toolCalls.length > 0

        let realtimeMessages = state.realtimeMessages
        // Never materialize an empty durable row. A second `done` after the SSE
        // settle (finishStream) used to upsert `assistant:<runId>` with no text
        // — Working unmounted and left a bare avatar.
        if (hasLiveContent) {
          realtimeMessages = syncLiveAssistantRow(
            state.realtimeMessages,
            sessionKey,
            settledStreaming,
            { streaming: false, timestamp: now },
          )
          const settledRow = realtimeMessages
            .get(sessionKey)
            ?.find(
              (message) =>
                getMessageId(message) === settledStreaming.messageId,
            )
          if (settledRow) {
            const settled: ChatMessage =
              event.state === 'interrupted'
                ? ({
                    ...settledRow,
                    __streamingStatus: 'error',
                  } as unknown as ChatMessage)
                : settledRow
            if (settled !== settledRow) {
              realtimeMessages = new Map(realtimeMessages)
              realtimeMessages.set(
                sessionKey,
                upsertMessageByDurableId(
                  realtimeMessages.get(sessionKey) ?? [],
                  settled,
                ),
              )
            }
            persistRecoveryMessage(sessionKey, settled)
          }
        } else if (settledStreaming.messageId) {
          // Empty/premature `done` must NOT tear down the seeded host or
          // streamingState. That wiped Working while Stop was still armed, and
          // finishStream then saw stillLive=null so reply text in refs never
          // settled — blank gap under the user bubble. Keep the live host;
          // finishStream / a later content-bearing done / clearStreamingSession
          // owns real teardown.
          break
        }

        streamingMap.delete(sessionKey)
        set({
          streamingState: streamingMap,
          realtimeMessages,
          lastEventAt: now,
        })
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem(`claude_streaming_${sessionKey}`)
        }
        break
      }
    }
  },

  getRealtimeMessages: (sessionKey) => {
    return get().realtimeMessages.get(sessionKey) ?? []
  },

  getStreamingState: (sessionKey) => {
    return get().streamingState.get(sessionKey) ?? null
  },

  clearSession: (sessionKey) => {
    const messages = new Map(get().realtimeMessages)
    const streaming = new Map(get().streamingState)
    messages.delete(sessionKey)
    streaming.delete(sessionKey)
    set({ realtimeMessages: messages, streamingState: streaming })
  },

  clearRealtimeBuffer: (sessionKey) => {
    const messages = new Map(get().realtimeMessages)
    messages.delete(sessionKey)
    set({ realtimeMessages: messages })
  },

  clearStreamingSession: (sessionKey) => {
    const key = sessionKey.trim()
    if (!key) return
    const streaming = new Map(get().streamingState)
    const had = streaming.delete(key)
    if (had) {
      set({ streamingState: streaming })
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(`claude_streaming_${key}`)
    }
  },

  beginStreamingTurn: ({ sessionKey, messageId, runId }) => {
    const key = sessionKey.trim()
    const id = messageId.trim()
    if (!key || !id) return
    const now = Date.now()
    const next: StreamingState = {
      ...createEmptyStreamingState(),
      messageId: id,
      runId: typeof runId === 'string' && runId.trim() ? runId.trim() : null,
    }
    const streaming = new Map(get().streamingState)
    streaming.set(key, next)
    // Keep settled write-through rows. Wiping the whole realtime buffer forced
    // turn N-1 back onto history merge (often msg-N + thinking reshape) the
    // instant turn N started — first bubble remounted / Activity flashed.
    // Only drop prior *live* hosts; clearStreamingSession still owns idle GC.
    const existing = get().realtimeMessages.get(key) ?? []
    const kept = existing.filter((message) => {
      if (message.role !== 'assistant') return true
      const status = (message as { __streamingStatus?: string }).__streamingStatus
      if (status === 'streaming') return false
      if (getMessageId(message) === id) return false
      return assistantHasVisibleHostContent(message)
    })
    const seededRealtime = new Map(get().realtimeMessages)
    seededRealtime.set(key, kept)
    const realtimeMessages = syncLiveAssistantRow(
      seededRealtime,
      key,
      next,
      { streaming: true, timestamp: now },
    )
    // Bump lastEventAt so useRealtimeChatHistory re-merges (it keys off this).
    set({ streamingState: streaming, realtimeMessages, lastEventAt: now })
  },

  clearAllStreaming: () => {
    if (get().streamingState.size === 0) return
    if (typeof sessionStorage !== 'undefined') {
      for (const key of get().streamingState.keys()) {
        sessionStorage.removeItem(`claude_streaming_${key}`)
      }
    }
    set({ streamingState: new Map() })
  },

  mergeHistoryMessages: (sessionKey, historyMessages) => {
    const realtimeMessages = get().realtimeMessages.get(sessionKey) ?? []

    if (realtimeMessages.length === 0) {
      return sortMessagesChronologically(historyMessages)
    }

    const matchesRealtimeMessage = (
      histMsg: ChatMessage,
      rtMsg: ChatMessage,
    ): boolean => {
      const rtId = getMessageId(rtMsg)
      const rtText = extractMessageText(rtMsg)
      const rtNonce = getClientNonce(rtMsg)
      const rtSignature = messageMultipartSignature(rtMsg)
      const histId = getMessageId(histMsg)
      // Durable Tutti identity — same row across stream and history echo.
      if (rtId && histId && rtId === histId) {
        return true
      }
      // Hermes history often uses msg-N while live used assistant:<runId>.
      // Match by shared runId when both carry it.
      const rtRun =
        typeof (rtMsg as { runId?: unknown }).runId === 'string'
          ? (rtMsg as { runId: string }).runId.trim()
          : ''
      const histRun =
        typeof (histMsg as { runId?: unknown }).runId === 'string'
          ? (histMsg as { runId: string }).runId.trim()
          : ''
      if (
        rtRun &&
        histRun &&
        rtRun === histRun &&
        histMsg.role === 'assistant' &&
        rtMsg.role === 'assistant'
      ) {
        return true
      }

      const histNonce = getClientNonce(histMsg)
      if (rtNonce && histNonce && rtNonce === histNonce) {
        return true
      }

      if (histMsg.role === rtMsg.role && rtText) {
        const histText = extractMessageText(histMsg)
        if (histText === rtText) return true
        // Streaming realtime text is a prefix of the final server text.
        // Match either direction to prevent duplicates when the server
        // returns the complete message after the realtime buffer had a
        // partial version.
        if (rtText.length > 0 && histText.length > 0) {
          if (histText.startsWith(rtText) || rtText.startsWith(histText))
            return true
        }
      }

      const histRaw = histMsg as Record<string, unknown>
      const histIsOptimistic =
        normalizeString(histRaw.status) === 'sending' ||
        normalizeString(histRaw.__optimisticId).length > 0

      if (histIsOptimistic && histMsg.role === rtMsg.role) {
        if (rtText) {
          const histText = extractMessageText(histMsg)
          if (histText === rtText) return true
          if (histText && rtText.startsWith(histText)) return true
        }
        const rtAttachments = Array.isArray((rtMsg as any).attachments)
          ? ((rtMsg as any).attachments as Array<Record<string, unknown>>)
          : []
        const histAttachments = Array.isArray((histMsg as any).attachments)
          ? ((histMsg as any).attachments as Array<Record<string, unknown>>)
          : []
        if (
          rtAttachments.length > 0 &&
          rtAttachments.length == histAttachments.length
        ) {
          const rtSig = rtAttachments
            .map((a) => `${normalizeString(a.name)}:${String(a.size ?? '')}`)
            .sort()
            .join('|')
          const histSig = histAttachments
            .map((a) => `${normalizeString(a.name)}:${String(a.size ?? '')}`)
            .sort()
            .join('|')
          if (rtSig && rtSig === histSig) return true
        }
      }

      return (
        rtSignature.length > 0 &&
        rtSignature === messageMultipartSignature(histMsg)
      )
    }

    const mergedHistoryMessages = historyMessages.map((histMsg) => {
      const matchingRealtime = realtimeMessages.find((rtMsg) =>
        matchesRealtimeMessage(histMsg, rtMsg),
      )
      if (!matchingRealtime) return histMsg
      // Preserve attachments from the optimistic/realtime message when history doesn't have them
      const merged = mergeRealtimeAssistantMetadata(histMsg, matchingRealtime)
      const rtAttachments = (matchingRealtime as any).attachments
      const histAttachments = (merged as any).attachments
      if (
        Array.isArray(rtAttachments) &&
        rtAttachments.length > 0 &&
        (!Array.isArray(histAttachments) || histAttachments.length === 0)
      ) {
        return { ...merged, attachments: rtAttachments }
      }
      return merged
    })

    const newRealtimeMessages = realtimeMessages.filter(
      (rtMsg) =>
        !mergedHistoryMessages.some((histMsg) =>
          matchesRealtimeMessage(histMsg, rtMsg),
        ),
    )

    const merged =
      newRealtimeMessages.length === 0
        ? sortMessagesChronologically(mergedHistoryMessages)
        : sortMessagesChronologically([
            ...mergedHistoryMessages,
            ...newRealtimeMessages,
          ])

    // Mid-poll history often surfaces tool-only / narration assistants while
    // the parent turn is still open. Fold them into the durable live host so
    // the transcript never paints settled fragments beside Working.
    const liveStreaming = get().streamingState.get(sessionKey)
    if (liveStreaming?.messageId) {
      return foldOpenTurnIntoLiveHost(merged, {
        liveMessageId: liveStreaming.messageId,
        isStreaming: true,
        streamingText: liveStreaming.text,
        streamingThinking: liveStreaming.thinking,
        toolCalls: liveStreaming.toolCalls,
        runId: liveStreaming.runId,
      })
    }

    return merged
  },
}))

function extractTextFromContent(
  content: Array<MessageContent> | undefined,
): string {
  if (!content || !Array.isArray(content)) return ''
  return stripFinalTags(
    content
      .filter(
        (c): c is TextContent =>
          c.type === 'text' && typeof (c as any).text === 'string',
      )
      .map((c) => c.text)
      .join('\n')
      .trim(),
  )
}

/**
 * Extract text from a ChatMessage using multiple strategies:
 *   1. content array (canonical format)
 *   2. top-level text/body/message fields (legacy / some server adapters)
 *
 * Some servers echo user messages with a top-level `text` field instead of
 * the `content` array. Using only extractTextFromContent() would return ''
 * for those, causing dedup to fail in mergeHistoryMessages.
 */
function extractMessageText(msg: ChatMessage | null | undefined): string {
  if (!msg) return ''
  const fromContent = extractTextFromContent(msg.content)
  if (fromContent.length > 0) return fromContent

  const raw = msg as Record<string, unknown>
  for (const key of ['text', 'body', 'message']) {
    const val = raw[key]
    if (typeof val === 'string' && val.trim().length > 0)
      return stripFinalTags(val.trim())
  }
  return ''
}

function ensureAssistantTextContent(msg: ChatMessage): ChatMessage {
  if (msg.role !== 'assistant') return msg
  if (Array.isArray(msg.content) && msg.content.length > 0) return msg

  const text = extractMessageText(msg)
  if (!text) return msg

  return {
    ...msg,
    content: [{ type: 'text', text } as TextContent],
  }
}

function mergeRealtimeAssistantMetadata(
  historyMessage: ChatMessage,
  realtimeMessage: ChatMessage,
): ChatMessage {
  if (
    historyMessage.role !== 'assistant' ||
    realtimeMessage.role !== 'assistant'
  ) {
    return historyMessage
  }

  const realtimeToolCalls = Array.isArray(
    (realtimeMessage as any).__streamToolCalls,
  )
    ? (realtimeMessage as any).__streamToolCalls
    : []
  const historyToolCalls = Array.isArray(
    (historyMessage as any).__streamToolCalls,
  )
    ? (historyMessage as any).__streamToolCalls
    : []
  const historyStreamToolCalls = Array.isArray(
    (historyMessage as any).streamToolCalls,
  )
    ? (historyMessage as any).streamToolCalls
    : []

  let merged: ChatMessage = historyMessage

  // Keep the live write-through identity. History often echoes as `msg-N`
  // while the durable row was `assistant:<runId>` — swapping id remounts the
  // list row (fade-in + Activity height collapse = transcript jump).
  const rtId = getMessageId(realtimeMessage)
  if (rtId && rtId.startsWith('assistant:')) {
    merged = {
      ...merged,
      id: rtId,
      messageId: rtId,
    }
  }
  const rtRun =
    typeof (realtimeMessage as { runId?: unknown }).runId === 'string'
      ? (realtimeMessage as { runId: string }).runId.trim()
      : ''
  if (rtRun) {
    merged = { ...merged, runId: rtRun }
  }

  // Preserve live tool pills when history has text but not stream tool metadata.
  if (
    realtimeToolCalls.length > 0 &&
    historyToolCalls.length === 0 &&
    historyStreamToolCalls.length === 0
  ) {
    merged = {
      ...merged,
      __streamToolCalls: realtimeToolCalls,
      streamToolCalls: realtimeToolCalls,
    }
  }

  // Preserve thinking the same way managed ACP keeps reasoning on the row —
  // history refetch often returns text-only assistant content.
  return mergeAssistantThinkingFromSource(merged, realtimeMessage)
}
