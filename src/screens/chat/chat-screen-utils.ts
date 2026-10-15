import { assistantHasWorkingSurface } from '@/lib/chat-message-parts'
import type { ChatAttachment, ChatMessage } from './types'

export type StickyStreamingTextState = {
  runId: string | null
  text: string
}

export type ResponseWaitSnapshot = {
  messageCount: number
  lastAssistantId: string | null
  lastAssistantText: string | null
}

/**
 * Manual Retry is shown for a rejected send (`error`) and for a send that
 * never left `sending`. Auto flush must ignore `sending`: that request may
 * still be in flight, and resending it would duplicate the turn.
 */
export function isRetryableUserMessage(
  message: ChatMessage,
  mode: 'manual' | 'auto',
): boolean {
  if ((message.role || '') !== 'user') return false
  const status = (message as { status?: unknown }).status
  const normalized = typeof status === 'string' ? status.trim() : ''
  if (normalized === 'error') return true
  return mode === 'manual' && normalized === 'sending'
}

export function isTerminalActiveRunStatus(status: unknown): boolean {
  return (
    typeof status === 'string' &&
    [
      'complete',
      'completed',
      'failed',
      'cancelled',
      'canceled',
      'error',
      'interrupted',
    ].includes(status)
  )
}

function assistantMessageIdentity(message: ChatMessage): string {
  return String(
    message.__optimisticId ??
      message.id ??
      message.messageId ??
      message.__realtimeSequence ??
      '',
  )
}

function assistantPlainText(message: ChatMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: unknown }).text ?? '')
      }
      return ''
    })
    .join('')
}

export function createResponseWaitSnapshot(
  messages: Array<ChatMessage>,
): ResponseWaitSnapshot {
  const last = messages[messages.length - 1]
  const isAssistant = last?.role === 'assistant'
  return {
    messageCount: messages.length,
    lastAssistantId: isAssistant ? assistantMessageIdentity(last) : null,
    lastAssistantText: isAssistant ? assistantPlainText(last) : null,
  }
}

export function shouldClearWaitingForAssistantMessage(
  messages: Array<ChatMessage>,
  snapshot: ResponseWaitSnapshot,
): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  if (last.__streamingStatus === 'streaming') return false

  // Empty placeholders stay in-flight. Any visible host (text / thinking /
  // tools) can settle waiting — TurnActivityHost owns busy via turnBusy, not
  // this flag.
  const currentText = assistantPlainText(last).trim()
  if (!currentText && !assistantHasWorkingSurface(last)) return false

  if (messages.length > snapshot.messageCount) return true

  const currentId = assistantMessageIdentity(last)
  if (currentId.length > 0 && currentId !== (snapshot.lastAssistantId ?? '')) {
    return true
  }

  // Same assistant row rewritten in place (e.g. interrupt text).
  if (
    snapshot.lastAssistantText !== null &&
    currentText.length > 0 &&
    currentText !== snapshot.lastAssistantText
  ) {
    return true
  }

  return snapshot.lastAssistantId === null
}

/**
 * Decide whether the waiting spinner can settle from an active-run probe.
 * `missing` means the server has no active run — callers should apply a short
 * grace period so registration lag right after send does not flicker the UI.
 */
export function shouldSettleWaitingFromActiveRun(
  run: {
    status?: unknown
  } | null,
): 'keep' | 'settle' | 'missing' {
  if (!run) return 'missing'
  if (isTerminalActiveRunStatus(run.status)) return 'settle'
  return 'keep'
}

/**
 * Complete live write-through for empty-settle recovery.
 * Thinking-only / tool-only rows do NOT count — Tutti settle requires a final
 * assistant text host (or an explicit error bubble) before skipping history refetch.
 */
export function hasFinalAssistantWriteThrough(
  messages: readonly ChatMessage[] | undefined | null,
): boolean {
  if (!messages || messages.length === 0) return false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    if ((message as { isError?: boolean }).isError) return true
    if (!Array.isArray(message.content)) {
      const text =
        typeof (message as { text?: unknown }).text === 'string'
          ? (message as { text: string }).text.trim()
          : ''
      if (text) return true
      continue
    }
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (
        rec.type === 'text' &&
        typeof rec.text === 'string' &&
        rec.text.trim().length > 0
      ) {
        return true
      }
    }
  }
  return false
}

export function advanceStickyStreamingText(params: {
  isStreaming: boolean
  runId: string | null
  rawText: string
  smoothedText: string
  previousState: StickyStreamingTextState
}): StickyStreamingTextState {
  const { isStreaming, runId, rawText, smoothedText, previousState } = params

  if (!isStreaming) {
    return { runId: null, text: '' }
  }

  const nextRunId = runId ?? previousState.runId ?? 'streaming'
  const isNewRun = nextRunId !== previousState.runId
  const candidateText = smoothedText || rawText
  const nextText =
    candidateText.length > 0
      ? candidateText
      : isNewRun
        ? ''
        : previousState.text

  return {
    runId: nextRunId,
    text: nextText,
  }
}

type OptimisticMessagePayload = {
  clientId: string
  optimisticId: string
  optimisticMessage: ChatMessage
}

export function createOptimisticMessage(
  body: string,
  attachments: Array<ChatAttachment> = [],
): OptimisticMessagePayload {
  const clientId = crypto.randomUUID()
  const optimisticId = `opt-${clientId}`
  const timestamp = Date.now()
  const textContent =
    body.length > 0 ? [{ type: 'text' as const, text: body }] : []

  const optimisticMessage: ChatMessage = {
    role: 'user',
    content: textContent.length > 0 ? textContent : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    __optimisticId: optimisticId,
    __createdAt: timestamp,
    clientId,
    client_id: clientId,
    status: 'sending',
    timestamp,
  }

  return { clientId, optimisticId, optimisticMessage }
}

/** Last `::` segment of a chat nav key (`profile::canonical::friendly`). */
export function friendlyIdFromNavKey(navKey: string): string {
  const idx = navKey.lastIndexOf('::')
  return idx === -1 ? navKey : navKey.slice(idx + 2)
}

/**
 * Cancel in-flight SSE when the user actually leaves a session.
 * Promoting `/chat/new` onto the session we just started must not abort
 * the first-turn stream — that leaves the bubble unanswered and the
 * optimistic session gets dropped on the next list refetch.
 *
 * Also: after new→thread, `activeCanonicalKey` often fills in a moment later
 * and changes the middle nav-key segment. That is not a session leave — aborting
 * here kills the first send before Hermes ever sees it (empty gateway history).
 */
export function shouldCancelStreamOnSessionNav(params: {
  previousNavKey: string | null
  nextNavKey: string
  nextFriendlyId: string
  activeSendKey?: string
}): boolean {
  const { previousNavKey, nextNavKey, nextFriendlyId, activeSendKey } = params
  if (previousNavKey === null || previousNavKey === nextNavKey) return false

  const prevFriendly = friendlyIdFromNavKey(previousNavKey)
  const nextFriendly =
    nextFriendlyId.trim() || friendlyIdFromNavKey(nextNavKey)

  // Same thread, nav key churn (canonical key / profile prefix only).
  if (prevFriendly !== 'new' && prevFriendly === nextFriendly) {
    return false
  }

  // In-flight send already targets this friendly id.
  if (
    nextFriendly !== 'new' &&
    Boolean(activeSendKey) &&
    nextFriendly === activeSendKey
  ) {
    return false
  }

  // `/chat/new` → first thread while createSession is still in flight
  // (activeSendRef not set yet). Cancelling here drops the pending first turn.
  if (prevFriendly === 'new' && nextFriendly !== 'new') {
    return false
  }

  return true
}

export function buildChatNavKey(input: {
  profileName: string
  canonicalSessionKey: string
  friendlyId: string
  isNewChat: boolean
}): string {
  const friendly = input.isNewChat ? 'new' : input.friendlyId
  return `${input.profileName}::${input.canonicalSessionKey ?? ''}::${friendly}`
}

export function profileNameFromNavKey(navKey: string): string {
  const idx = navKey.indexOf('::')
  return idx === -1 ? '' : navKey.slice(0, idx)
}

/** Profile switch should hand off the in-flight stream instead of aborting it. */
export function shouldHandoffStreamOnProfileNav(
  previousNavKey: string | null,
  nextNavKey: string,
): boolean {
  if (!previousNavKey || previousNavKey === nextNavKey) return false
  const prevProfile = profileNameFromNavKey(previousNavKey)
  const nextProfile = profileNameFromNavKey(nextNavKey)
  if (!prevProfile || !nextProfile) return false
  return prevProfile !== nextProfile
}
