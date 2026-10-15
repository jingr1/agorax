/**
 * Map Hermes gateway history ChatMessage[] → Engine durable Activity messages,
 * and merge with live Engine/overlay rows by **turn identity** (not body text).
 *
 * Contract (docs/hermes-native-bridge.md §2.1 / §2.3):
 *   Reconcile = 补洞 / stamp id / version — never mint a second row for the
 *   same turn under msg-N while live already owns assistant:<runId>.
 */

import type {
  AgentActivityDurableMessage,
  AgentActivityMessage,
} from '@agorax/agent-activity-core'
import { assistantMessageIdForRun, readDurableMessageId } from './chat-turn-identity'
import type { ChatMessage } from '@/screens/chat/types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageTimestamp(message: ChatMessage, index: number): number {
  const raw = message.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return index + 1
}

function contentParts(message: ChatMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part): part is Record<string, unknown> =>
          Boolean(part) && typeof part === 'object',
      )
    : []
}

/** Gateway ordinal ids are not turn identity — never prefer them over live. */
export function isWeakHermesGatewayMessageId(messageId: string): boolean {
  const id = messageId.trim()
  return (
    id.startsWith('msg-') ||
    id.startsWith('assistant:history:') ||
    id.startsWith('user:history:')
  )
}

function durableAssistantId(
  message: ChatMessage,
  agentSessionId: string,
  index: number,
): string {
  const existing = readDurableMessageId(message)
  const runId = readString(message.runId).trim()
  if (existing && !isWeakHermesGatewayMessageId(existing)) return existing
  if (runId) return assistantMessageIdForRun(runId, agentSessionId)
  if (existing) return existing
  return `assistant:history:${agentSessionId}:${index}`
}

function durableUserId(
  message: ChatMessage,
  agentSessionId: string,
  index: number,
): string {
  const existing = readDurableMessageId(message)
  const clientSubmitId = readString(
    (message as { clientSubmitId?: unknown }).clientSubmitId,
  ).trim()
  if (clientSubmitId) return `user:${clientSubmitId}`
  if (existing && !isWeakHermesGatewayMessageId(existing)) return existing
  if (existing) return existing
  return `user:history:${agentSessionId}:${index}`
}

function turnIdFor(message: ChatMessage, messageId: string): string {
  const turnId = readString((message as { turnId?: unknown }).turnId).trim()
  if (turnId) return turnId
  const runId = readString(message.runId).trim()
  if (runId) return `turn-${runId}`
  if (messageId.startsWith('assistant:')) {
    const rest = messageId.slice('assistant:'.length)
    const bare = rest.endsWith(':thinking')
      ? rest.slice(0, -':thinking'.length)
      : rest.split(':text:')[0] ?? rest
    if (bare && !bare.startsWith('history:')) return `turn-${bare}`
  }
  if (messageId.startsWith('user:')) return `turn-${messageId.slice('user:'.length)}`
  return `turn-${messageId}`
}

type HermesActivityTurn = {
  user: AgentActivityDurableMessage | null
  rest: AgentActivityDurableMessage[]
}

function laneKind(row: AgentActivityMessage): string {
  if (row.kind === 'tool_call' || row.kind === 'tool') return 'tool_call'
  if (row.kind === 'reasoning' || row.role === 'assistant_thinking') {
    return 'reasoning'
  }
  return 'text'
}

function partitionHermesActivityTurns(
  rows: readonly AgentActivityDurableMessage[],
): HermesActivityTurn[] {
  const turns: HermesActivityTurn[] = []
  let current: HermesActivityTurn | null = null
  for (const row of rows) {
    if (row.role === 'user') {
      current = { user: row, rest: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { user: null, rest: [row] }
      turns.push(current)
      continue
    }
    current.rest.push(row)
  }
  return turns
}

function toDurable(
  row: AgentActivityMessage,
  workspaceId: string,
  agentSessionId: string,
  sequence: number,
): AgentActivityDurableMessage {
  return {
    workspaceId: row.workspaceId ?? workspaceId,
    agentSessionId: row.agentSessionId || agentSessionId,
    messageId: row.messageId,
    version: sequence,
    sequence,
    turnId: row.turnId,
    role: row.role,
    kind: row.kind,
    status: row.status ?? null,
    semantics: row.semantics,
    payload: { ...row.payload },
    occurredAtUnixMs: row.occurredAtUnixMs,
  }
}

function stampRow(
  identity: AgentActivityDurableMessage,
  content: AgentActivityDurableMessage | undefined,
): AgentActivityDurableMessage {
  if (!content) return identity
  const identityText =
    typeof identity.payload.text === 'string' ? identity.payload.text : ''
  const contentText =
    typeof content.payload.text === 'string' ? content.payload.text : ''
  // Keep live identity; adopt history payload only when it adds substance.
  const useContentPayload =
    contentText.trim().length > identityText.trim().length ||
    (identityText.trim().length === 0 && contentText.trim().length > 0) ||
    (identity.kind === 'tool_call' && content.kind === 'tool_call')
  return {
    ...identity,
    turnId: identity.turnId ?? content.turnId,
    status: content.status ?? identity.status,
    payload: useContentPayload ? { ...content.payload } : { ...identity.payload },
    occurredAtUnixMs: Math.min(
      identity.occurredAtUnixMs,
      content.occurredAtUnixMs,
    ),
  }
}

function stampTurn(
  historyTurn: HermesActivityTurn,
  liveTurn: HermesActivityTurn,
): AgentActivityDurableMessage[] {
  const out: AgentActivityDurableMessage[] = []
  if (liveTurn.user) {
    out.push(stampRow(liveTurn.user, historyTurn.user ?? undefined))
  } else if (historyTurn.user) {
    out.push(historyTurn.user)
  }

  const kinds = ['reasoning', 'tool_call', 'text'] as const
  for (const kind of kinds) {
    const liveLane = liveTurn.rest.filter((row) => laneKind(row) === kind)
    const histLane = historyTurn.rest.filter((row) => laneKind(row) === kind)
    const n = Math.max(liveLane.length, histLane.length)
    for (let i = 0; i < n; i += 1) {
      const liveRow = liveLane[i]
      const histRow = histLane[i]
      if (liveRow && histRow) out.push(stampRow(liveRow, histRow))
      else if (liveRow) out.push(liveRow)
      else if (histRow) out.push(histRow)
    }
  }
  return out
}

function turnIdentityKeys(turn: HermesActivityTurn): Set<string> {
  const keys = new Set<string>()
  const add = (row: AgentActivityDurableMessage | null | undefined) => {
    if (!row) return
    if (!isWeakHermesGatewayMessageId(row.messageId)) {
      keys.add(`id:${row.messageId}`)
    }
    const submit = readString(row.payload.clientSubmitId).trim()
    if (submit) keys.add(`submit:${submit}`)
    if (row.messageId.startsWith('assistant:')) {
      const rest = row.messageId.slice('assistant:'.length)
      const bare = rest.endsWith(':thinking')
        ? rest.slice(0, -':thinking'.length)
        : rest.split(':text:')[0] ?? rest
      // assistant:pending:<session>:<clientSubmitId> → pair history echoes
      // that only share the submit/turn nonce (no runId yet).
      if (bare.startsWith('pending:')) {
        const turnKey = bare.split(':').slice(2).join(':').trim()
        if (turnKey) keys.add(`submit:${turnKey}`)
      } else {
        const run = bare.split(':')[0] ?? ''
        if (run && run !== 'history') {
          keys.add(`run:${run}`)
        }
      }
    }
    if (row.turnId?.startsWith('turn-')) {
      const bare = row.turnId.slice('turn-'.length)
      if (bare && !bare.startsWith('msg-') && !bare.startsWith('history:')) {
        keys.add(`turn:${bare}`)
      }
    }
  }
  add(turn.user)
  for (const row of turn.rest) add(row)
  return keys
}

function turnsShareIdentity(
  left: HermesActivityTurn,
  right: HermesActivityTurn,
): boolean {
  const a = turnIdentityKeys(left)
  if (a.size === 0) return false
  for (const key of turnIdentityKeys(right)) {
    if (a.has(key)) return true
  }
  return false
}

function turnTimeRange(turn: HermesActivityTurn): {
  min: number
  max: number
} {
  const times = [
    ...(turn.user ? [turn.user.occurredAtUnixMs] : []),
    ...turn.rest.map((row) => row.occurredAtUnixMs),
  ].filter((value) => Number.isFinite(value) && value > 0)
  if (times.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...times), max: Math.max(...times) }
}

/** History echo of a live turn should not be far older than the live turn. */
function turnsTemporallyCompatible(
  historyTurn: HermesActivityTurn,
  liveTurn: HermesActivityTurn,
): boolean {
  const hist = turnTimeRange(historyTurn)
  const live = turnTimeRange(liveTurn)
  if (!hist.max || !live.min) return true
  // Allow history timestamps in seconds (gateway) vs ms — normalize roughly.
  const histMax = hist.max < 1e12 ? hist.max * 1000 : hist.max
  const liveMin = live.min < 1e12 ? live.min * 1000 : live.min
  return histMax + 120_000 >= liveMin
}

function flattenTurn(turn: HermesActivityTurn): AgentActivityDurableMessage[] {
  return [...(turn.user ? [turn.user] : []), ...turn.rest]
}

/**
 * Merge gateway history with live Engine/overlay by turn identity:
 * 1) pair turns that share durable messageId / clientSubmitId / runId
 * 2) ordinal-pair remaining turns from the end (history suffix ↔ live suffix)
 * Live messageIds always win on a pair (stamp). No body-text fingerprinting.
 */
export function mergeHermesHistoryWithLiveByTurnIdentity(input: {
  workspaceId: string
  agentSessionId: string
  history: readonly AgentActivityDurableMessage[]
  live: readonly AgentActivityMessage[]
}): AgentActivityDurableMessage[] {
  const workspaceId = input.workspaceId.trim() || 'default'
  const agentSessionId = input.agentSessionId.trim()
  const liveDurable = input.live.map((row, index) =>
    toDurable(row, workspaceId, agentSessionId, index + 1),
  )
  if (liveDurable.length === 0) {
    return renumber(input.history)
  }
  if (input.history.length === 0) {
    return renumber(liveDurable)
  }

  const historyTurns = partitionHermesActivityTurns(input.history)
  const liveTurns = partitionHermesActivityTurns(liveDurable)
  const histMatched = new Array(historyTurns.length).fill(false)
  const liveMatched = new Array(liveTurns.length).fill(false)
  const stampByLiveIndex = new Map<number, AgentActivityDurableMessage[]>()

  for (let li = 0; li < liveTurns.length; li += 1) {
    for (let hi = 0; hi < historyTurns.length; hi += 1) {
      if (histMatched[hi] || liveMatched[li]) continue
      if (!turnsShareIdentity(liveTurns[li]!, historyTurns[hi]!)) continue
      stampByLiveIndex.set(
        li,
        stampTurn(historyTurns[hi]!, liveTurns[li]!),
      )
      histMatched[hi] = true
      liveMatched[li] = true
    }
  }

  // Ordinal suffix among leftovers. Skip pairs that are temporally impossible
  // (stale history turn vs a newer live-only turn when history lags).
  let hi = historyTurns.length - 1
  let li = liveTurns.length - 1
  while (hi >= 0 && li >= 0) {
    while (hi >= 0 && histMatched[hi]) hi -= 1
    while (li >= 0 && liveMatched[li]) li -= 1
    if (hi < 0 || li < 0) break
    if (!turnsTemporallyCompatible(historyTurns[hi]!, liveTurns[li]!)) {
      break
    }
    stampByLiveIndex.set(li, stampTurn(historyTurns[hi]!, liveTurns[li]!))
    histMatched[hi] = true
    liveMatched[li] = true
    hi -= 1
    li -= 1
  }

  const out: AgentActivityDurableMessage[] = []
  for (let i = 0; i < historyTurns.length; i += 1) {
    if (histMatched[i]) continue
    out.push(...flattenTurn(historyTurns[i]!))
  }
  for (let i = 0; i < liveTurns.length; i += 1) {
    const stamped = stampByLiveIndex.get(i)
    if (stamped) out.push(...stamped)
    else if (!liveMatched[i]) out.push(...flattenTurn(liveTurns[i]!))
  }

  return renumber(out)
}

function renumber(
  rows: readonly AgentActivityDurableMessage[],
): AgentActivityDurableMessage[] {
  return rows.map((row, index) => ({
    ...row,
    sequence: index + 1,
    version: index + 1,
  }))
}

/**
 * Convert one history page into durable Activity messages.
 * Expands combined assistant content into reasoning / tool_call / text rows.
 * Does not fingerprint-dedupe — identity merge happens in
 * `mergeHermesHistoryWithLiveByTurnIdentity`.
 */
export function hermesHistoryMessagesToActivity(input: {
  workspaceId: string
  agentSessionId: string
  messages: readonly ChatMessage[]
}): AgentActivityDurableMessage[] {
  const workspaceId = input.workspaceId.trim() || 'default'
  const agentSessionId = input.agentSessionId.trim()
  if (!agentSessionId) return []

  const out: AgentActivityDurableMessage[] = []
  let sequence = 0
  const seenIds = new Set<string>()

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]
    if (!message) continue
    const role = readString(message.role).trim() || 'assistant'
    const occurredAtUnixMs = messageTimestamp(message, index)
    const parts = contentParts(message)

    if (role === 'user') {
      sequence += 1
      const messageId = durableUserId(message, agentSessionId, index)
      if (seenIds.has(messageId)) continue
      seenIds.add(messageId)
      const text =
        parts
          .map((part) => (part.type === 'text' ? readString(part.text) : ''))
          .join('')
          .trim() || readString(message.text).trim()
      out.push({
        workspaceId,
        agentSessionId,
        messageId,
        version: sequence,
        sequence,
        turnId: turnIdFor(message, messageId),
        role: 'user',
        kind: 'text',
        status: null,
        payload: {
          text,
          content: text,
          ...(readString((message as { clientSubmitId?: unknown }).clientSubmitId)
            ? {
                clientSubmitId: readString(
                  (message as { clientSubmitId?: unknown }).clientSubmitId,
                ).trim(),
              }
            : {}),
        },
        occurredAtUnixMs,
      })
      continue
    }

    if (role !== 'assistant' && role !== 'assistant_thinking') continue

    const baseId = durableAssistantId(message, agentSessionId, index)
    const turnId = turnIdFor(message, baseId)
    const status =
      message.__streamingStatus === 'streaming'
        ? 'streaming'
        : message.__streamingStatus === 'error' || message.isError
          ? 'failed'
          : 'completed'

    let emittedText = false
    let emittedThinking = false

    for (const part of parts) {
      const type = readString(part.type)
      if (
        type === 'thinking' ||
        type === 'redacted_thinking' ||
        type === 'reasoning'
      ) {
        const thinking =
          readString(part.thinking) ||
          readString(part.text) ||
          readString(part.reasoning)
        if (!thinking.trim()) continue
        sequence += 1
        const messageId = emittedThinking
          ? `${baseId}:thinking:${sequence}`
          : `${baseId}:thinking`
        if (seenIds.has(messageId)) continue
        seenIds.add(messageId)
        out.push({
          workspaceId,
          agentSessionId,
          messageId,
          version: sequence,
          sequence,
          turnId,
          role: 'assistant_thinking',
          kind: 'reasoning',
          status,
          payload: { text: thinking, content: thinking },
          occurredAtUnixMs,
        })
        emittedThinking = true
        continue
      }
      if (type === 'toolCall' || type === 'tool_call' || type === 'tool') {
        const toolCallId =
          readString(part.id) ||
          readString(part.toolCallId) ||
          `${baseId}:tool:${sequence + 1}`
        const name =
          readString(part.name) || readString(message.toolName) || 'tool'
        sequence += 1
        const messageId = toolCallId.startsWith('toolcall:')
          ? toolCallId
          : `toolcall:${toolCallId}`
        if (seenIds.has(messageId)) continue
        seenIds.add(messageId)
        const details = asRecord(message.details)
        out.push({
          workspaceId,
          agentSessionId,
          messageId,
          version: sequence,
          sequence,
          turnId,
          role: 'assistant',
          kind: 'tool_call',
          status: message.isError ? 'failed' : 'completed',
          payload: {
            name,
            toolName: name,
            input:
              asRecord(part.arguments) ??
              asRecord(part.input) ??
              details?.input,
            output: details?.output ?? part.result ?? part.output,
          },
          occurredAtUnixMs,
        })
        continue
      }
      if (type === 'text' || !type) {
        const text = readString(part.text)
        if (!text) continue
        sequence += 1
        const messageId = emittedText ? `${baseId}:text:${sequence}` : baseId
        if (seenIds.has(messageId)) continue
        seenIds.add(messageId)
        out.push({
          workspaceId,
          agentSessionId,
          messageId,
          version: sequence,
          sequence,
          turnId,
          role: 'assistant',
          kind: 'text',
          status,
          payload: { text, content: text },
          occurredAtUnixMs,
        })
        emittedText = true
      }
    }

    if (!emittedText && !emittedThinking && parts.length === 0) {
      const text =
        readString(message.text) ||
        readString((message as { __streamingText?: unknown }).__streamingText)
      sequence += 1
      if (seenIds.has(baseId)) continue
      seenIds.add(baseId)
      out.push({
        workspaceId,
        agentSessionId,
        messageId: baseId,
        version: sequence,
        sequence,
        turnId,
        role: 'assistant',
        kind: 'text',
        status,
        payload: { text, content: text },
        occurredAtUnixMs,
      })
    }
  }

  return renumber(out)
}
