import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  foldTrailingAssistantThinking,
  reconcileHistoryResponse,
} from '@/lib/chat-history-reconcile'
import { useChatStream } from '../../../hooks/use-chat-stream'
import { useChatStore } from '../../../stores/chat-store'
import { appendHistoryMessage, chatQueryKeys, fetchHistory } from '../chat-queries'
import { toast } from '../../../components/ui/toast'
import { textFromMessage } from '../utils'
import { hasFinalAssistantWriteThrough } from '../chat-screen-utils'
import { snapshotOptimisticUserMessages } from './optimistic-message-reinject'
import type { ChatMessage, HistoryResponse } from '../types'
import type { StreamingState } from '../../../stores/chat-store'

const PORTABLE_HISTORY_STORAGE_KEY = 'claude_portable_chat_main'
const PORTABLE_HISTORY_LIMIT = 100

/**
 * Extract plain-text content from a user message for dedup comparison.
 *
 * Uses a multi-field strategy because different server versions / channel
 * adapters shape the SSE payload differently:
 *   • Modern format:  content: [{type:'text', text:'...'}]
 *   • Legacy format:  text: '...' | body: '...' | message: '...'
 */
function extractUserMessageText(message: ChatMessage): string {
  // Primary: content-array format (modern canonical)
  const fromContent = textFromMessage(message).trim()
  if (fromContent.length > 0) return fromContent

  // Fallback: top-level text/body/message fields (legacy / some channel adapters)
  const raw = message as Record<string, unknown>
  for (const key of ['text', 'body', 'message']) {
    const val = raw[key]
    if (typeof val === 'string' && val.trim().length > 0) return val.trim()
  }

  return ''
}

function persistPortableHistory(messages: Array<ChatMessage>) {
  if (typeof window === 'undefined') return

  const persistedMessages = messages
    .filter((message) => message.__streamingStatus !== 'streaming')
    .slice(-PORTABLE_HISTORY_LIMIT)

  try {
    window.localStorage.setItem(
      PORTABLE_HISTORY_STORAGE_KEY,
      JSON.stringify({
        messages: persistedMessages,
        updatedAt: Date.now(),
      }),
    )
  } catch {
    // Ignore persistence failures (quota, private mode, malformed messages).
  }
}

const EMPTY_MESSAGES: Array<ChatMessage> = []
const EMPTY_TOOL_CALLS: Array<{
  id: string
  name: string
  phase: string
  args?: unknown
}> = []
const EMPTY_LIFECYCLE_EVENTS: StreamingState['lifecycleEvents'] = []

type UseRealtimeChatHistoryOptions = {
  sessionKey: string
  friendlyId: string
  historyMessages: Array<ChatMessage>
  enabled?: boolean
  onUserMessage?: (message: ChatMessage, source?: string) => void
  onApprovalRequest?: (approval: Record<string, unknown>) => void
  onCompactionStart?: () => void
  onCompactionEnd?: () => void
}

type CompactionEvent = {
  phase?: string
  sessionKey: string
}

/**
 * Hook that makes SSE the PRIMARY source for new messages and streaming.
 * - Streaming chunks update the chat-store (already happens)
 * - When 'done' arrives, the complete message is immediately available
 * - History polling is now just a backup/backfill mechanism
 */
export function useRealtimeChatHistory({
  sessionKey,
  friendlyId,
  historyMessages,
  enabled = true,
  portableMode = false,
  onUserMessage,
  onApprovalRequest,
  onCompactionStart,
  onCompactionEnd,
}: UseRealtimeChatHistoryOptions & { portableMode?: boolean }) {
  const queryClient = useQueryClient()
  const effectiveFriendlyId = portableMode ? 'main' : friendlyId
  const effectiveSessionKey = portableMode ? 'main' : sessionKey
  const [lastCompletedRunAt, setLastCompletedRunAt] = useState<number | null>(
    null,
  )
  const completedStreamingTextRef = useRef<string>('')
  const completedStreamingThinkingRef = useRef<string>('')
  const lastCompactionSignalRef = useRef<string>('')
  const isBackfillingRef = useRef(false)
  const clearCompletedStreaming = useCallback(() => {
    completedStreamingTextRef.current = ''
    completedStreamingThinkingRef.current = ''
  }, [])

  const backfillHistory = useCallback(async () => {
    if (!effectiveSessionKey || effectiveSessionKey === 'new') return
    if (isBackfillingRef.current) return

    isBackfillingRef.current = true
    try {
      const key = chatQueryKeys.history(
        effectiveFriendlyId,
        effectiveSessionKey,
      )
      const serverData = await fetchHistory({
        sessionKey: effectiveSessionKey,
        friendlyId: effectiveFriendlyId,
      })
      const current = queryClient.getQueryData<HistoryResponse>(key)
      queryClient.setQueryData(
        key,
        reconcileHistoryResponse(current, serverData) ?? serverData,
      )
    } catch {
      // Keep the current cache on backfill failure.
    } finally {
      isBackfillingRef.current = false
    }
  }, [effectiveFriendlyId, effectiveSessionKey, queryClient])

  useEffect(() => {
    if (!enabled) return
    if (!effectiveSessionKey || effectiveSessionKey === 'new') return
    void backfillHistory()
  }, [backfillHistory, effectiveSessionKey, enabled])

  const { connectionState, lastError, reconnect } = useChatStream({
    sessionKey: effectiveSessionKey === 'new' ? undefined : effectiveSessionKey,
    enabled: enabled && effectiveSessionKey !== 'new',
    onReconnect: useCallback(() => {
      void backfillHistory()
    }, [backfillHistory]),
    onSilentTimeout: useCallback(
      (_silentForMs: number) => {
        void backfillHistory()
      },
      [backfillHistory],
    ),
    onUserMessage: useCallback(
      (message: ChatMessage, source?: string) => {
        // Filter internal system messages (pre-compaction flushes, heartbeat
        // prompts, subagent announcements) — these should never appear in the
        // chat UI. The chat-store has its own filter, but this callback
        // also appends directly to the query cache via appendHistoryMessage,
        // bypassing the store filter entirely.
        if (message.role === 'user') {
          const msgText = extractUserMessageText(message)
          if (
            msgText.startsWith('Pre-compaction memory flush') ||
            msgText.startsWith('Store durable memories now') ||
            msgText.startsWith(
              'APPEND new content only and do not overwrite',
            ) ||
            msgText.startsWith('A subagent task') ||
            msgText.startsWith('[Queued announce messages') ||
            msgText.startsWith('Summarize this naturally for the user') ||
            (msgText.startsWith('Stats: runtime') &&
              msgText.includes('sessionKey agent:'))
          ) {
            onUserMessage?.(message, source)
            return
          }
        }

        clearCompletedStreaming()

        // Append (or merge into an existing pending local message) via the
        // shared history cache updater. appendHistoryMessage replaces optimistic
        // / sent-but-unechoed copies instead of appending duplicates.
        if (effectiveSessionKey && effectiveSessionKey !== 'new') {
          appendHistoryMessage(
            queryClient,
            effectiveFriendlyId,
            effectiveSessionKey,
            {
              ...message,
              __realtimeSource: source,
            },
          )
        }
        onUserMessage?.(message, source)
      },
      [
        clearCompletedStreaming,
        effectiveFriendlyId,
        effectiveSessionKey,
        onUserMessage,
        queryClient,
      ],
    ),
    onDone: useCallback(
      (
        _state: string,
        eventSessionKey: string,
        streamingSnapshot: StreamingState | null,
      ) => {
        const currentState =
          eventSessionKey === effectiveSessionKey ? streamingSnapshot : null
        if (currentState?.text) {
          completedStreamingTextRef.current = currentState.text
        }
        if (currentState?.thinking) {
          completedStreamingThinkingRef.current = currentState.thinking
        }

        // Track when generation completes for this session
        if (
          eventSessionKey === effectiveSessionKey ||
          !effectiveSessionKey ||
          effectiveSessionKey === 'new'
        ) {
          setLastCompletedRunAt(Date.now())
          // Tutti settle contract: live write-through is the turn authority.
          // Do NOT clear the realtime buffer or refetch history when the live
          // assistant already has content — that swapped data sources and felt
          // like a page refresh after stream. History is only a quiet recovery
          // path for empty settle / focus / reconnect (stamp ids, not replace).
          if (effectiveSessionKey && effectiveSessionKey !== 'new') {
            const key = chatQueryKeys.history(
              effectiveFriendlyId,
              effectiveSessionKey,
            )
            const prevData =
              queryClient.getQueryData<Record<string, unknown>>(key)
            const prevCount =
              (prevData?.messages as Array<unknown> | undefined)?.length ?? 0

            const reInjectOptimistic = snapshotOptimisticUserMessages(
              queryClient,
              effectiveFriendlyId,
              effectiveSessionKey,
            )

            const store = useChatStore.getState()
            const realtimeMessages =
              store.realtimeMessages.get(effectiveSessionKey) ?? []
            const historyMessages = prevData?.messages as
              | Array<unknown>
              | undefined

            // Portable only: splice chat-store into RQ history. Hermes 1:1 list
            // is Engine-primary — merging here dual-wrote msg-N + assistant:runId.
            if (
              portableMode &&
              realtimeMessages.length > 0 &&
              Array.isArray(historyMessages)
            ) {
              const historyTexts = new Set(
                historyMessages.map((m: unknown) => {
                  const raw = m as Record<string, unknown>
                  const content = raw.content ?? raw.text ?? ''
                  return `${raw.role ?? ''}:${JSON.stringify(content)}`
                }),
              )
              const dedupedRealtime = realtimeMessages.filter((m: unknown) => {
                const raw = m as Record<string, unknown>
                const content = raw.content ?? raw.text ?? ''
                const sig = `${raw.role ?? ''}:${JSON.stringify(content)}`
                return !historyTexts.has(sig)
              })

              if (dedupedRealtime.length > 0) {
                const merged = [...historyMessages, ...dedupedRealtime].sort(
                  (a: unknown, b: unknown) => {
                    const aTs = (a as Record<string, unknown>).createdAt as
                      | number
                      | undefined
                    const bTs = (b as Record<string, unknown>).createdAt as
                      | number
                      | undefined
                    if (typeof aTs === 'number' && typeof bTs === 'number')
                      return aTs - bTs
                    return 0
                  },
                )
                queryClient.setQueryData(key, {
                  ...(prevData ?? {}),
                  messages: merged,
                })
              }
            }

            const completedAssistant =
              realtimeMessages.length > 0
                ? (() => {
                    const last = realtimeMessages[
                      realtimeMessages.length - 1
                    ] as Record<string, unknown> | undefined
                    return last?.role === 'assistant' ? last : null
                  })()
                : null

            const completedRow = completedAssistant as
              | (Record<string, unknown> & {
                  content?: unknown
                  __streamingThinking?: unknown
                })
              | null
            const thinkingSource = {
              role: 'assistant' as const,
              content: completedRow?.content,
              __streamingThinking:
                (typeof completedRow?.__streamingThinking === 'string'
                  ? completedRow.__streamingThinking
                  : '') ||
                completedStreamingThinkingRef.current ||
                '',
            }

            // Thinking-only ≠ complete write-through (Tutti settle): must still
            // quiet-fetch history when final assistant text is missing.
            const liveTurnComplete =
              hasFinalAssistantWriteThrough(realtimeMessages as ChatMessage[]) ||
              store.streamingState.has(effectiveSessionKey)

            if (liveTurnComplete) {
              // Keep realtime write-through mounted. Only mirror into the
              // query cache so later quiet polls can stamp server ids.
              if (thinkingSource.__streamingThinking) {
                const current =
                  queryClient.getQueryData<HistoryResponse>(key)
                if (current?.messages) {
                  const folded = foldTrailingAssistantThinking(
                    current.messages,
                    thinkingSource,
                  )
                  if (folded !== current.messages) {
                    queryClient.setQueryData(key, {
                      ...current,
                      messages: folded,
                    })
                  }
                }
              }
              clearCompletedStreaming()
              reInjectOptimistic()
              return
            }

            // Empty settle (no visible live assistant) — quiet fetch for recovery.
            store.clearRealtimeBuffer(effectiveSessionKey)
            clearCompletedStreaming()
            void fetchHistory({
              sessionKey: effectiveSessionKey,
              friendlyId: effectiveFriendlyId,
            })
              .then((serverData) => {
                const current =
                  queryClient.getQueryData<HistoryResponse>(key)
                let next =
                  reconcileHistoryResponse(current, serverData) ?? serverData

                if (thinkingSource.__streamingThinking) {
                  next = {
                    ...next,
                    messages: foldTrailingAssistantThinking(
                      next.messages ?? [],
                      thinkingSource,
                    ),
                  }
                }

                queryClient.setQueryData(key, next)
                reInjectOptimistic()

                const newCount = next.messages?.length ?? 0
                if (
                  prevCount > 10 &&
                  newCount > 0 &&
                  newCount < prevCount * 0.6
                ) {
                  onCompactionEnd?.()
                  toast(
                    'Context compacted — older messages were summarized to free up space',
                    {
                      type: 'info',
                      icon: '🗜️',
                      duration: 8000,
                    },
                  )
                }
              })
              .catch(() => {
                reInjectOptimistic()
              })
          }
        }
      },
      [
        clearCompletedStreaming,
        effectiveFriendlyId,
        effectiveSessionKey,
        onCompactionEnd,
        queryClient,
      ],
    ),
    onCompaction: useCallback(
      (event: CompactionEvent) => {
        if (!event.sessionKey || event.sessionKey !== effectiveSessionKey)
          return

        if (event.phase === 'start') {
          lastCompactionSignalRef.current = `compaction:${event.sessionKey}:start`
          onCompactionStart?.()
          return
        }

        if (event.phase === 'end') {
          lastCompactionSignalRef.current = ''
          onCompactionEnd?.()
        }
      },
      [effectiveSessionKey, onCompactionEnd, onCompactionStart],
    ),
    onApprovalRequest,
  })

  const mergeHistoryMessages = useChatStore((s) => s.mergeHistoryMessages)
  const clearSession = useChatStore((s) => s.clearSession)
  const lastEventAt = useChatStore((s) => s.lastEventAt)
  const realtimeMessages = useChatStore(
    (s) => s.realtimeMessages.get(effectiveSessionKey) ?? EMPTY_MESSAGES,
  )

  // Subscribe directly to streaming state — useMemo with stable fn ref was stale (bug #1)
  const streamingState = useChatStore(
    (s) => s.streamingState.get(effectiveSessionKey) ?? null,
  )
  const streamingStateRef = useRef(streamingState)
  const lastStreamClearTimeRef = useRef<number>(0)
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const delayedClearSessionTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)
  const activeSessionKeyRef = useRef(effectiveSessionKey)
  const isUnmountingRef = useRef(false)
  activeSessionKeyRef.current = effectiveSessionKey

  useEffect(() => {
    const prev = streamingStateRef.current
    streamingStateRef.current = streamingState
    const startedNewStream =
      streamingState !== null &&
      (prev === null || prev.runId !== streamingState.runId)
    if (startedNewStream) {
      clearCompletedStreaming()
    }
    // Streaming just completed — capture final text so the message stays
    // visible during the handoff from streaming placeholder to history message.
    // The stub useChatStream never fires onDone, so this is the only path.
    if (prev && prev.text && !streamingState) {
      completedStreamingTextRef.current = prev.text
      if (prev.thinking) {
        completedStreamingThinkingRef.current = prev.thinking
      }
      lastStreamClearTimeRef.current = Date.now()
    }
  }, [clearCompletedStreaming, streamingState])

  // Merge history with real-time messages
  // Re-merge when realtime events arrive (lastEventAt changes)
  const mergedMessages = useMemo(() => {
    if (effectiveSessionKey === 'new') return historyMessages
    return mergeHistoryMessages(effectiveSessionKey, historyMessages)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSessionKey, historyMessages, mergeHistoryMessages, lastEventAt])

  useEffect(() => {
    if (!portableMode) return
    if (mergedMessages.length === 0) return
    persistPortableHistory(mergedMessages)
  }, [mergedMessages, portableMode])

  useEffect(() => {
    if (!onCompactionStart) return
    if (realtimeMessages.length === 0) return
    const latest = realtimeMessages[realtimeMessages.length - 1]

    const textCandidates = [
      textFromMessage(latest),
      ...(Array.isArray(latest.content) ? latest.content : []).map((part) => {
        if (part.type === 'text') return String(part.text ?? '')
        if (part.type === 'thinking') return String(part.thinking ?? '')
        return ''
      }),
    ]
      .join('\n')
      .toLowerCase()

    // Only trigger on Hermes Agent's actual mid-compaction signal.
    // "pre-compaction memory flush" and "store durable memories now" are routine
    // heartbeat messages — do NOT match those here.
    if (!textCandidates.includes('compacting context')) return

    const signal = `${latest.role ?? ''}:${textCandidates}`
    if (signal === lastCompactionSignalRef.current) return
    lastCompactionSignalRef.current = signal
    onCompactionStart()
  }, [onCompactionStart, realtimeMessages])

  // Periodic history sync — catch missed messages every 30s
  // Skip during active streaming to prevent race conditions
  useEffect(() => {
    if (!effectiveSessionKey || effectiveSessionKey === 'new' || !enabled)
      return
    syncIntervalRef.current = setInterval(() => {
      // Don't poll during active streaming — causes flicker/overwrites
      if (streamingStateRef.current !== null) return
      // Guard window: don't poll right after streaming clears — new stream
      // may be starting and history API may return stale/incomplete data
      if (Date.now() - lastStreamClearTimeRef.current < 3000) return
      const key = chatQueryKeys.history(
        effectiveFriendlyId,
        effectiveSessionKey,
      )
      queryClient.invalidateQueries({ queryKey: key })
    }, 30000)
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
    }
  }, [effectiveFriendlyId, effectiveSessionKey, enabled, queryClient])

  // Clear realtime buffer when session changes
  useEffect(() => {
    if (!effectiveSessionKey || effectiveSessionKey === 'new') return undefined
    if (delayedClearSessionTimeoutRef.current) {
      clearTimeout(delayedClearSessionTimeoutRef.current)
      delayedClearSessionTimeoutRef.current = null
    }

    // Clear on unmount/session change after a delay
    // to allow history to catch up
    return () => {
      if (isUnmountingRef.current) return
      if (delayedClearSessionTimeoutRef.current) {
        clearTimeout(delayedClearSessionTimeoutRef.current)
      }
      delayedClearSessionTimeoutRef.current = setTimeout(() => {
        delayedClearSessionTimeoutRef.current = null
        if (activeSessionKeyRef.current === effectiveSessionKey) return
        clearSession(effectiveSessionKey)
      }, 5000)
    }
  }, [effectiveSessionKey, clearSession])

  useEffect(() => {
    isUnmountingRef.current = false
    return () => {
      isUnmountingRef.current = true
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
      if (delayedClearSessionTimeoutRef.current) {
        clearTimeout(delayedClearSessionTimeoutRef.current)
        delayedClearSessionTimeoutRef.current = null
      }
    }
  }, [])

  // Compute streaming UI state
  const isRealtimeStreaming = streamingState !== null
  const realtimeStreamingText = streamingState?.text ?? ''
  const realtimeStreamingThinking = streamingState?.thinking ?? ''
  const realtimeStreamingMessageId = streamingState?.messageId ?? null
  const realtimeLifecycleEvents =
    streamingState?.lifecycleEvents ?? EMPTY_LIFECYCLE_EVENTS

  return {
    messages: mergedMessages,
    connectionState,
    lastError,
    reconnect,
    isRealtimeStreaming,
    realtimeStreamingText,
    realtimeStreamingThinking,
    realtimeStreamingMessageId,
    realtimeLifecycleEvents,
    clearCompletedStreaming,
    streamingRunId: streamingState?.runId ?? null,
    activeToolCalls: streamingState?.toolCalls ?? EMPTY_TOOL_CALLS,
    lastCompletedRunAt, // Parent watches this to clear waitingForResponse
  }
}
