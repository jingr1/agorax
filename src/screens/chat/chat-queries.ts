import { normalizeSessions, readError } from './utils'
import type { QueryClient } from '@tanstack/react-query'
import type {
  ChatMessage,
  HistoryResponse,
  SessionListResponse,
  SessionMeta,
} from './types'

type StatusResponse = {
  ok: boolean
  error?: string
  status?: number
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function getMessageClientId(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const candidates = [raw.clientId, raw.client_id]
  for (const candidate of candidates) {
    const normalized = normalizeId(candidate)
    if (normalized) return normalized
  }
  return ''
}

function getMessageOptimisticId(message: ChatMessage): string {
  return normalizeId(message.__optimisticId)
}

function isMatchingClientMessage(
  message: ChatMessage,
  clientId: string,
  optimisticId: string,
): boolean {
  const messageClientId = getMessageClientId(message)
  if (messageClientId === clientId) return true

  const messageOptimisticId = getMessageOptimisticId(message)
  if (!messageOptimisticId) return false
  if (messageOptimisticId === clientId) return true
  if (messageOptimisticId === optimisticId) return true
  return false
}

/** First paint. The hook then fills up to HISTORY_FULL_LIMIT in the background. */
export const HISTORY_FIRST_PAINT_LIMIT = 40
/** Server cap. Matches the largest window /api/history will return. */
export const HISTORY_FULL_LIMIT = 500

export const chatQueryKeys = {
  /** Prefix for all session queries (use for invalidation). */
  sessions: ['chat', 'sessions'] as const,
  /** Full query key for a specific profile's sessions (use for get/setQueryData). */
  sessionsForProfile: (profileName: string) =>
    [...chatQueryKeys.sessions, profileName] as const,
  history: function history(friendlyId: string, sessionKey: string) {
    return ['chat', 'history', friendlyId, sessionKey] as const
  },
} as const

export async function fetchSessions(
  profile?: string,
): Promise<Array<SessionMeta>> {
  const url = profile
    ? `/api/sessions?profile=${encodeURIComponent(profile)}`
    : '/api/sessions'
  const res = await fetch(url)
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as SessionListResponse
  return normalizeSessions(data.sessions)
}

export async function fetchHistory(payload: {
  sessionKey: string
  friendlyId: string
  profile?: string
  /** Initial paint should stay small; default keeps last N messages. */
  limit?: number
}): Promise<HistoryResponse> {
  const limit = Math.min(
    HISTORY_FULL_LIMIT,
    Math.max(1, payload.limit ?? HISTORY_FULL_LIMIT),
  )
  const query = new URLSearchParams({ limit: String(limit) })
  if (payload.sessionKey) query.set('sessionKey', payload.sessionKey)
  if (payload.friendlyId) query.set('friendlyId', payload.friendlyId)
  if (payload.profile) query.set('profile', payload.profile)
  const res = await fetch(`/api/history?${query.toString()}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as HistoryResponse
}

export async function fetchStatus(): Promise<StatusResponse> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch('/api/ping', { signal: controller.signal })
    if (!res.ok) {
      const error = new Error(await readError(res)) as Error & {
        status?: number
      }
      error.status = res.status
      throw error
    }
    const payload = (await res.json()) as StatusResponse
    return {
      ...payload,
      status: res.status,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Server check timed out')
    }
    throw err
  } finally {
    window.clearTimeout(timeout)
  }
}

export function updateHistoryMessages(
  queryClient: QueryClient,
  friendlyId: string,
  sessionKey: string,
  updater: (messages: Array<ChatMessage>) => Array<ChatMessage>,
) {
  const queryKey = chatQueryKeys.history(friendlyId, sessionKey)
  queryClient.setQueryData(queryKey, function update(data: unknown) {
    const current = data as HistoryResponse | undefined
    const messages = Array.isArray(current?.messages) ? current.messages : []
    const nextMessages = updater(messages)
    return {
      sessionKey: current?.sessionKey ?? sessionKey,
      sessionId: current?.sessionId,
      messages: nextMessages,
    }
  })
}

/**
 * Extract normalized plain text content from a ChatMessage for dedup
 * comparison. Handles both content-array and legacy text/message fields.
 */
function normalizeMessageText(message: ChatMessage): string {
  const raw = message as Record<string, unknown>

  // Prefer structured content array (canonical format)
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => {
        if (part.type === 'text') return String(part.text ?? '')
        return ''
      })
      .join('')
      .trim()
    if (text.length > 0) return text
  }

  // Fall back to legacy top-level text/message fields (some server / channel
  // adapters use these instead of the content-array format)
  for (const key of ['text', 'message', 'body']) {
    const val = raw[key]
    if (typeof val === 'string' && val.trim().length > 0) return val.trim()
  }

  return ''
}

/**
 * Build an attachment identity signature for image-only dedup.
 * Uses name + size because those survive the round-trip through the server;
 * the base64 content is stripped before storage/history.
 */
function normalizeAttachmentSignature(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  const attachments = Array.isArray(raw.attachments)
    ? (raw.attachments as Array<Record<string, unknown>>)
    : []
  if (attachments.length === 0) return ''
  return attachments
    .map((a) => `${String(a.name ?? '')}:${String(a.size ?? '')}`)
    .sort()
    .join('|')
}

function getMessageServerId(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  return normalizeId(raw.id) || normalizeId(raw.messageId)
}

/** Local user message still awaiting a server echo (optimistic or confirmed send). */
function isPendingLocalUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false

  const raw = message as Record<string, unknown>
  if (normalizeId(raw.__optimisticId).length > 0) return true

  const status = normalizeId(raw.status)
  if (status === 'sending' || status === 'queued') return true

  const clientId = getMessageClientId(message)
  const serverId = getMessageServerId(message)
  if (
    clientId &&
    !serverId &&
    (status === 'sent' || status === 'done' || status.length === 0)
  ) {
    return true
  }

  return false
}

function mergeConfirmedUserMessage(
  existing: ChatMessage,
  incoming: ChatMessage,
): ChatMessage {
  const incomingClientId = getMessageClientId(incoming)
  const existingClientId = getMessageClientId(existing)
  return {
    ...existing,
    ...incoming,
    clientId: existingClientId || incomingClientId || undefined,
    client_id: existingClientId || incomingClientId || undefined,
    __optimisticId: undefined,
    status: undefined,
  }
}

function findRecentMatchingUserMessageIndex(
  messages: Array<ChatMessage>,
  incomingMessage: ChatMessage,
  nowMs = Date.now(),
): number {
  if (incomingMessage.role !== 'user') return -1

  const incomingText = normalizeMessageText(incomingMessage)
  const incomingAttachSig = normalizeAttachmentSignature(incomingMessage)
  const incomingClientId = getMessageClientId(incomingMessage)
  const incomingOptimisticId = getMessageOptimisticId(incomingMessage)
  const TEN_SECONDS = 10_000

  return messages.findIndex((message) => {
    if (message.role !== 'user') return false

    if (
      incomingClientId &&
      isMatchingClientMessage(
        message,
        incomingClientId,
        incomingOptimisticId || `opt-${incomingClientId}`,
      )
    ) {
      return true
    }

    if (!incomingText && !incomingAttachSig) return false

    const textMatch =
      incomingText.length > 0 && normalizeMessageText(message) === incomingText
    const attachMatch =
      incomingAttachSig.length > 0 &&
      normalizeAttachmentSignature(message) === incomingAttachSig
    const isContentMatch =
      (incomingText.length > 0 && textMatch) ||
      (incomingText.length === 0 && incomingAttachSig.length > 0 && attachMatch)

    if (!isContentMatch) return false

    const raw = message as Record<string, unknown>
    const timestamp =
      typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : null
    if (timestamp !== null) {
      return nowMs - timestamp < TEN_SECONDS
    }

    const idx = messages.indexOf(message)
    return idx >= messages.length - 5
  })
}

function replaceMatchingOptimisticUserMessage(
  messages: Array<ChatMessage>,
  incomingMessage: ChatMessage,
): Array<ChatMessage> | null {
  if (incomingMessage.role !== 'user') return null

  const nowMs = Date.now()

  const matchIndex = messages.findIndex((message) => {
    if (!isPendingLocalUserMessage(message)) return false
    return (
      findRecentMatchingUserMessageIndex([message], incomingMessage, nowMs) ===
      0
    )
  })

  if (matchIndex === -1) return null

  const existing = messages[matchIndex]
  const replacement = mergeConfirmedUserMessage(existing, incomingMessage)

  const next = [...messages]
  next[matchIndex] = replacement
  return next
}

export function appendHistoryMessage(
  queryClient: QueryClient,
  friendlyId: string,
  sessionKey: string,
  message: ChatMessage,
) {
  updateHistoryMessages(
    queryClient,
    friendlyId,
    sessionKey,
    function append(messages) {
      const replacedOptimistic = replaceMatchingOptimisticUserMessage(
        messages,
        message,
      )
      if (replacedOptimistic) return replacedOptimistic

      // Dedup: if a message with the same clientId (or optimistic id) already
      // exists, skip appending — prevents double-display when an optimistic
      // message is added on send and then echoed back via SSE onUserMessage.
      const incomingClientId = getMessageClientId(message)
      const incomingOptimisticId = getMessageOptimisticId(message)
      if (incomingClientId || incomingOptimisticId) {
        const optimisticKey = incomingClientId ? `opt-${incomingClientId}` : ''
        const alreadyExists = messages.some((m) =>
          isMatchingClientMessage(
            m,
            incomingClientId || incomingOptimisticId,
            optimisticKey || incomingOptimisticId,
          ),
        )
        if (alreadyExists) return messages
      }

      // Fallback dedup for SSE-echoed user messages that arrive WITHOUT a
      // clientId (server did not echo it back). Check if an existing optimistic
      // user message with the same text content (or attachment signature for
      // image-only sends) was added in the last 10 seconds. This prevents
      // duplicates without dropping legitimately repeated messages sent at
      // longer intervals.
      if (
        message.role === 'user' &&
        !incomingClientId &&
        !incomingOptimisticId
      ) {
        const incomingText = normalizeMessageText(message)
        const incomingAttachSig = normalizeAttachmentSignature(message)
        // Only apply dedup if there is SOME identity to match against
        if (incomingText.length > 0 || incomingAttachSig.length > 0) {
          const duplicateIndex = findRecentMatchingUserMessageIndex(
            messages,
            message,
          )
          if (duplicateIndex >= 0) {
            const next = [...messages]
            next[duplicateIndex] = mergeConfirmedUserMessage(
              messages[duplicateIndex],
              message,
            )
            return next
          }
        }
      }

      // Insert in timestamp order so that late-arriving SSE echoes (e.g. a
      // user message whose echo arrives after the assistant reply is already
      // displayed) appear in the correct chronological position rather than
      // being appended to the bottom of the list.
      const incomingTs =
        typeof (message as Record<string, unknown>).timestamp === 'number'
          ? ((message as Record<string, unknown>).timestamp as number)
          : null

      if (incomingTs !== null) {
        // Find the first existing message whose timestamp is strictly greater
        // than the incoming message — insert before it.
        const insertIdx = messages.findIndex((m) => {
          const ts =
            typeof (m as Record<string, unknown>).timestamp === 'number'
              ? ((m as Record<string, unknown>).timestamp as number)
              : null
          return ts !== null && ts > incomingTs
        })
        if (insertIdx >= 0) {
          const next = [...messages]
          next.splice(insertIdx, 0, message)
          return next
        }
      }

      return [...messages, message]
    },
  )
}

export function updateHistoryMessageByClientId(
  queryClient: QueryClient,
  friendlyId: string,
  sessionKey: string,
  clientId: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  const normalizedClientId = normalizeId(clientId)
  if (!normalizedClientId) return
  const optimisticId = `opt-${normalizedClientId}`
  updateHistoryMessages(
    queryClient,
    friendlyId,
    sessionKey,
    function update(messages) {
      return messages.map((message) => {
        if (
          isMatchingClientMessage(message, normalizedClientId, optimisticId)
        ) {
          return updater(message)
        }
        return message
      })
    },
  )
}

export function updateHistoryMessageByClientIdEverywhere(
  queryClient: QueryClient,
  clientId: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  const normalizedClientId = normalizeId(clientId)
  if (!normalizedClientId) return
  const optimisticId = `opt-${normalizedClientId}`
  const historyQueries = queryClient.getQueriesData<HistoryResponse>({
    queryKey: ['chat', 'history'],
  })

  for (const [queryKey, data] of historyQueries) {
    const current = data
    const messages = Array.isArray(current?.messages) ? current.messages : []
    let changed = false
    const nextMessages = messages.map((message) => {
      if (!isMatchingClientMessage(message, normalizedClientId, optimisticId)) {
        return message
      }
      changed = true
      return updater(message)
    })
    if (!changed) continue
    queryClient.setQueryData(queryKey, {
      sessionKey: current?.sessionKey ?? '',
      sessionId: current?.sessionId,
      messages: nextMessages,
    })
  }
}

export function removeHistoryMessageByClientId(
  queryClient: QueryClient,
  friendlyId: string,
  sessionKey: string,
  clientId: string,
  optimisticId?: string,
) {
  const normalizedClientId = normalizeId(clientId)
  if (!normalizedClientId) return
  const resolvedOptimisticId =
    normalizeId(optimisticId) || `opt-${normalizedClientId}`

  updateHistoryMessages(
    queryClient,
    friendlyId,
    sessionKey,
    function remove(messages) {
      return messages.filter((message) => {
        return !isMatchingClientMessage(
          message,
          normalizedClientId,
          resolvedOptimisticId,
        )
      })
    },
  )
}

export function clearHistoryMessages(
  queryClient: QueryClient,
  friendlyId: string,
  sessionKey: string,
) {
  const queryKey = chatQueryKeys.history(friendlyId, sessionKey)
  queryClient.setQueryData(queryKey, {
    sessionKey,
    messages: [],
  })
}

export function moveHistoryMessages(
  queryClient: QueryClient,
  fromFriendlyId: string,
  fromSessionKey: string,
  toFriendlyId: string,
  toSessionKey: string,
) {
  const fromKey = chatQueryKeys.history(fromFriendlyId, fromSessionKey)
  const toKey = chatQueryKeys.history(toFriendlyId, toSessionKey)
  const fromData = queryClient.getQueryData(fromKey) as
    | Record<string, unknown>
    | undefined
  if (!fromData) return
  const messages = Array.isArray(fromData.messages) ? fromData.messages : []
  queryClient.setQueryData(toKey, {
    sessionKey: toSessionKey,
    sessionId: (fromData as any).sessionId,
    messages,
  })
  queryClient.removeQueries({ queryKey: fromKey, exact: true })
}

export function reconcileSessionDraft(
  queryClient: QueryClient,
  activeProfileName: string,
  fromFriendlyId: string,
  fromSessionKey: string,
  toFriendlyId: string,
  toSessionKey: string,
) {
  queryClient.setQueryData(
    chatQueryKeys.sessionsForProfile(activeProfileName),
    function reconcile(existing: unknown) {
      if (!Array.isArray(existing)) return existing
      const sessions = existing as Array<SessionMeta>
      const sourceIndex = sessions.findIndex((session) => {
        return (
          session.friendlyId === fromFriendlyId ||
          session.key === fromSessionKey ||
          session.key === fromFriendlyId
        )
      })

      if (sourceIndex === -1) {
        return sessions
      }

      const source = sessions[sourceIndex]
      const targetIndex = sessions.findIndex((session, index) => {
        if (index === sourceIndex) return false
        return (
          session.friendlyId === toFriendlyId ||
          session.key === toSessionKey ||
          session.key === toFriendlyId
        )
      })

      if (targetIndex === -1) {
        return sessions.map((session, index) => {
          if (index !== sourceIndex) return session
          return {
            ...session,
            key: toSessionKey,
            friendlyId: toFriendlyId,
          }
        })
      }

      return sessions.flatMap((session, index) => {
        if (index === sourceIndex) return []
        if (index !== targetIndex) return [session]
        return [
          {
            ...session,
            key: toSessionKey,
            friendlyId: toFriendlyId,
            lastMessage: source.lastMessage ?? session.lastMessage,
            updatedAt:
              Math.max(source.updatedAt ?? 0, session.updatedAt ?? 0) ||
              session.updatedAt ||
              source.updatedAt,
            label: session.label ?? source.label,
            title: session.title ?? source.title,
            derivedTitle: session.derivedTitle ?? source.derivedTitle,
            titleStatus:
              session.titleStatus === 'idle'
                ? source.titleStatus
                : session.titleStatus,
            titleSource: session.titleSource ?? source.titleSource,
            titleError: session.titleError ?? source.titleError,
          },
        ]
      })
    },
  )
}

export function updateSessionLastMessage(
  queryClient: QueryClient,
  activeProfileName: string,
  sessionKey: string,
  friendlyId: string,
  message: ChatMessage,
) {
  queryClient.setQueryData(
    chatQueryKeys.sessionsForProfile(activeProfileName),
    function update(messages: unknown) {
      if (!Array.isArray(messages)) return messages
      return (messages as Array<SessionMeta>).map((session) => {
        if (session.key !== sessionKey && session.friendlyId !== friendlyId) {
          return session
        }
        return {
          ...session,
          lastMessage: message,
        }
      })
    },
  )
}

export function removeSessionFromCache(
  queryClient: QueryClient,
  activeProfileName: string,
  sessionKey: string,
  friendlyId: string,
) {
  queryClient.setQueryData(
    chatQueryKeys.sessionsForProfile(activeProfileName),
    function update(messages: unknown) {
      if (!Array.isArray(messages)) return messages
      return (messages as Array<SessionMeta>).filter((session) => {
        return session.key !== sessionKey && session.friendlyId !== friendlyId
      })
    },
  )

  queryClient.removeQueries({
    queryKey: ['chat', 'history', friendlyId],
    exact: false,
  })
  if (sessionKey && sessionKey !== friendlyId) {
    queryClient.removeQueries({
      queryKey: ['chat', 'history', sessionKey],
      exact: false,
    })
  }
}

/** Collapse same-turn duplicate user bubbles (optimistic + server echo). */
export function collapseRecentDuplicateUserMessages(
  messages: Array<ChatMessage>,
): Array<ChatMessage> {
  const keep = new Set<ChatMessage>()
  const seenText = new Map<string, ChatMessage>()
  const FIFTEEN_SECONDS = 15_000

  for (const message of messages) {
    if (message.role !== 'user') {
      keep.add(message)
      continue
    }

    const text = normalizeMessageText(message).replace(/\s+/g, ' ').trim()
    if (!text) {
      keep.add(message)
      continue
    }

    const existing = seenText.get(text)
    if (!existing) {
      seenText.set(text, message)
      keep.add(message)
      continue
    }

    const raw = message as Record<string, unknown>
    const existingRaw = existing as Record<string, unknown>
    const ts = typeof raw.timestamp === 'number' ? raw.timestamp : null
    const existingTs =
      typeof existingRaw.timestamp === 'number' ? existingRaw.timestamp : null
    if (
      ts !== null &&
      existingTs !== null &&
      Math.abs(ts - existingTs) > FIFTEEN_SECONDS
    ) {
      keep.add(message)
      continue
    }

    const serverId = getMessageServerId(message)
    const existingServerId = getMessageServerId(existing)
    if (!existingServerId && serverId) {
      keep.delete(existing)
      seenText.set(text, message)
      keep.add(message)
    }
  }

  return messages.filter((message) => keep.has(message))
}
