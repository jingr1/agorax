/**
 * Transcript projection: Engine/list ChatMessages → AgentTranscriptRowVM.
 *
 * Face contract (open turn):
 * - Single transcript `processing:<turnKey>` row owns AssistantAvatar for the
 *   whole open turn (with or without a durable assistant message).
 * - Durable assistant MessageItems under that turn do not remount a second face.
 * - processing is display-only — never written to messagesBySessionId.
 */

import { readDurableMessageId } from '@/lib/chat-turn-identity'
import type { ChatMessage } from '../types'

export type AgentTranscriptMessageRow = {
  kind: 'message'
  key: string
  speaker: 'user' | 'assistant'
  message: ChatMessage
  sourceIndex: number
}

/** Open-turn face slot — display only, never written to the message bucket. */
export type AgentTranscriptProcessingRow = {
  kind: 'processing'
  key: string
  turnKey: string
  sourceIndex: number
}

export type AgentTranscriptRowVM =
  | AgentTranscriptMessageRow
  | AgentTranscriptProcessingRow

export type ProjectTranscriptOptions = {
  turnBusy?: boolean
  isStreaming?: boolean
  streamingMessageId?: string | null
  /** Open-turn nonce (`clientSubmitId`) for processing:<turnKey>. */
  openTurnKey?: string | null
}

function durableId(message: ChatMessage): string {
  return readDurableMessageId(
    message as { id?: unknown; messageId?: unknown },
  )
}

function clientSubmitIdFromUser(message: ChatMessage): string {
  const raw = message as {
    clientSubmitId?: unknown
    payload?: { clientSubmitId?: unknown }
  }
  const fromTop =
    typeof raw.clientSubmitId === 'string' ? raw.clientSubmitId.trim() : ''
  if (fromTop) return fromTop
  const id = durableId(message)
  return id.startsWith('user:') && !id.startsWith('user:history:')
    ? id.slice('user:'.length).trim()
    : ''
}

/**
 * Project filtered/sorted ChatMessages into transcript rows.
 * While the turn is open, insert one processing face slot after the latest
 * user (stable key for the whole turn — durable assistant does not replace it).
 */
export function projectChatToTranscriptRows(
  messages: readonly ChatMessage[],
  options: ProjectTranscriptOptions = {},
): AgentTranscriptRowVM[] {
  const rows: AgentTranscriptRowVM[] = []
  let lastUserIndex = -1
  let lastUserTurnKey = ''

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    const role = (message.role || '').toLowerCase()

    if (role === 'user') {
      lastUserIndex = rows.length
      lastUserTurnKey =
        options.openTurnKey?.trim() ||
        clientSubmitIdFromUser(message) ||
        durableId(message) ||
        `idx:${index}`
      rows.push({
        kind: 'message',
        key: durableId(message) || `user-idx:${index}`,
        speaker: 'user',
        message,
        sourceIndex: index,
      })
      continue
    }

    if (role !== 'assistant') continue
    if ((message as { __isNarration?: unknown }).__isNarration) continue

    const id = durableId(message) || `assistant-idx:${index}`
    rows.push({
      kind: 'message',
      key: id,
      speaker: 'assistant',
      message,
      sourceIndex: index,
    })
  }

  const turnOpen = options.turnBusy === true || options.isStreaming === true
  if (turnOpen && lastUserIndex >= 0) {
    const turnKey =
      options.openTurnKey?.trim() || lastUserTurnKey || 'open'
    rows.splice(lastUserIndex + 1, 0, {
      kind: 'processing',
      key: `processing:${turnKey}`,
      turnKey,
      sourceIndex: -1,
    })
  }

  return rows
}

/** True when an open-turn face slot (processing) is mounted. */
export function transcriptHasOpenTurnFace(
  rows: readonly AgentTranscriptRowVM[],
): boolean {
  return rows.some((row) => row.kind === 'processing')
}

/** Open-turn assistant hosts that sit under the processing face slot. */
export function isOpenTurnAssistantUnderProcessing(
  rows: readonly AgentTranscriptRowVM[],
  rowIndex: number,
): boolean {
  const row = rows[rowIndex]
  if (!row || row.kind !== 'message' || row.speaker !== 'assistant') {
    return false
  }
  for (let i = rowIndex - 1; i >= 0; i -= 1) {
    const prev = rows[i]
    if (!prev) continue
    if (prev.kind === 'processing') return true
    if (prev.kind === 'message' && prev.speaker === 'user') return false
  }
  return false
}
