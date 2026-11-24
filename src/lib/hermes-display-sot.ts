/**
 * Hermes 1:1 display SoT helpers.
 *
 * Agorax-initiated turns: daemon agent.db strong ids are authoritative.
 * Gateway SSE is execution/live overlay only — never a second display SoT.
 * External CLI / state.db sessions remain weak-id (msg-*) read-only.
 *
 * Idle daemon replace must not clobber a live Engine that already holds the
 * settled turn while RQ still serves a stale pre-turn page (busy→idle race).
 */

import type { ChatMessage } from '@/screens/chat/types'

function messageIdOf(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  for (const key of ['messageId', 'id'] as const) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function activityMessageId(message: { messageId?: string; id?: string }): string {
  return message.messageId?.trim() || message.id?.trim() || ''
}

/**
 * Display-critical strong ids owned by the live Engine / SSE turn.
 * Thinking/tool rows are folded into the assistant host on history pages, so
 * they must not block coverage.
 */
export function liveDisplayStrongIds(
  messages: readonly { messageId?: string; id?: string }[],
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const id = activityMessageId(message)
    if (!id || seen.has(id)) continue
    if (id.startsWith('user:history:') || id.startsWith('assistant:history:')) {
      continue
    }
    if (id.startsWith('user:')) {
      seen.add(id)
      ids.push(id)
      continue
    }
    if (
      id.startsWith('assistant:') &&
      !id.includes(':thinking') &&
      !id.includes(':pending:')
    ) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * True when every live display host is present on the history page.
 * Stale RQ (missing the just-settled user/assistant) must return false so
 * reconcile keeps the Engine snapshot instead of wiping the open turn.
 */
export function historyCoversLiveDisplayIds(
  history: readonly { messageId?: string; id?: string }[],
  live: readonly { messageId?: string; id?: string }[],
): boolean {
  if (live.length === 0) return true
  const required = liveDisplayStrongIds(live)
  if (required.length === 0) return true
  const hist = new Set<string>()
  for (const message of history) {
    const id = activityMessageId(message)
    if (id) hist.add(id)
  }
  for (const id of required) {
    if (!hist.has(id)) return false
  }
  return true
}

/** True when this history page is daemon-canonical (Tutti-homologous). */
export function isDaemonCanonicalHistory(
  messages: readonly ChatMessage[] | null | undefined,
): boolean {
  if (!messages || messages.length === 0) return false
  let sawStrong = false
  for (const message of messages) {
    if ((message as { __daemon?: unknown }).__daemon === true) {
      return true
    }
    const id = messageIdOf(message)
    if (
      id.startsWith('user:') ||
      id.startsWith('assistant:') ||
      id.startsWith('toolcall:')
    ) {
      if (id.startsWith('assistant:history:') || id.startsWith('user:history:')) {
        continue
      }
      sawStrong = true
      continue
    }
    if (id.startsWith('msg-')) return false
  }
  return sawStrong
}

/**
 * Settle must not fetch /api/history to length-win stamp live hosts.
 * SSE `done.message` + daemon hermes-bridge persist are the only writers.
 */
export function shouldFetchHistoryForSettle(_input?: {
  doneCarriedFinalText?: boolean
  liveText?: string
}): boolean {
  return false
}
