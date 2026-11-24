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
import { stripWorkspaceDirective } from './workspace-message-scope'
import { stripAgentPreferences } from './agent-preferences-text'
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

/**
 * Align RQ optimistic rows (`clientId` / `opt-<uuid>`) with Engine
 * `ingestUserPrompt` ids (`user:<clientSubmitId>`). Without this, mid-turn
 * history reconcile maps optimistic to `user:history:…` and leaves it beside
 * the live `user:<uuid>` / gateway `msg-*` echo.
 */
function readClientSubmitId(message: ChatMessage): string {
  const direct = readString(
    (message as { clientSubmitId?: unknown }).clientSubmitId,
  ).trim()
  if (direct) return direct
  const clientId =
    readString((message as { clientId?: unknown }).clientId).trim() ||
    readString((message as { client_id?: unknown }).client_id).trim()
  if (clientId) return clientId
  const optimisticId = readString(
    (message as { __optimisticId?: unknown }).__optimisticId,
  ).trim()
  if (optimisticId.startsWith('opt-')) {
    const bare = optimisticId.slice('opt-'.length).trim()
    if (bare) return bare
  }
  return ''
}

function durableUserId(
  message: ChatMessage,
  agentSessionId: string,
  index: number,
): string {
  const existing = readDurableMessageId(message)
  const clientSubmitId = readClientSubmitId(message)
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

/**
 * Resolve a durable turn bucket key. Prefer explicit turnId; for users fall
 * back to turn-<clientSubmitId> from messageId so assistants that already
 * carry turn-* can join before the user row is seen in list order.
 */
function turnPartitionKey(
  row: AgentActivityDurableMessage,
): string | null {
  const turnId = row.turnId?.trim()
  if (turnId) return turnId
  if (row.role === 'user' && row.messageId.startsWith('user:')) {
    const submit = row.messageId.slice('user:'.length).trim()
    if (submit) return `turn-${submit}`
  }
  const submit =
    typeof row.payload.clientSubmitId === 'string'
      ? row.payload.clientSubmitId.trim()
      : ''
  if (submit) return `turn-${submit}`
  return null
}

/** Gateway often mints turn-msg-N per row — not a real cross-turn boundary. */
function isWeakGatewayTurnId(turnId: string): boolean {
  return /^turn-msg-\d+$/i.test(turnId) || turnId.startsWith('turn-history:')
}

/**
 * Partition by turn identity, not only user boundaries.
 *
 * Live overlay often sorts next-turn thinking/text *above* the new user
 * (same ms as the prompt). A user-boundary partition then stuffed that
 * content into the previous turn's `rest`, and stampRow length-wins
 * replaced the prior reply body (「谢。」 → next turn's long text).
 *
 * Strong turn ids (turn-<clientSubmitId>) get their own bucket even before
 * the user row appears. Weak gateway turn-msg-N still attaches to the open
 * user bucket so msg-N history can stamp onto live assistant:run_*.
 */
function partitionHermesActivityTurns(
  rows: readonly AgentActivityDurableMessage[],
): HermesActivityTurn[] {
  type Bucket = HermesActivityTurn & { order: number }
  const byKey = new Map<string, Bucket>()
  const ordered: Bucket[] = []
  let fallback: Bucket | null = null
  let seq = 0

  const ensureKey = (key: string): Bucket => {
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = { user: null, rest: [], order: seq++ }
      byKey.set(key, bucket)
      ordered.push(bucket)
    }
    return bucket
  }

  for (const row of rows) {
    const key = turnPartitionKey(row)
    if (row.role === 'user') {
      if (key) {
        const bucket = ensureKey(key)
        bucket.user = row
        fallback = bucket
      } else {
        fallback = { user: row, rest: [], order: seq++ }
        ordered.push(fallback)
      }
      continue
    }

    if (key && byKey.has(key)) {
      byKey.get(key)!.rest.push(row)
      continue
    }

    // Next-turn live fragments that sorted above their user: hold in a
    // strong-id orphan bucket instead of contaminating the prior user turn.
    if (key && !isWeakGatewayTurnId(key)) {
      ensureKey(key).rest.push(row)
      continue
    }

    if (fallback) {
      fallback.rest.push(row)
      continue
    }

    if (key) {
      ensureKey(key).rest.push(row)
    } else {
      fallback = { user: null, rest: [row], order: seq++ }
      ordered.push(fallback)
    }
  }

  return ordered
    .sort((left, right) => left.order - right.order)
    .map(({ user, rest }) => ({ user, rest }))
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
  const identityTurn = identity.turnId?.trim() ?? ''
  const contentTurn = content.turnId?.trim() ?? ''
  // Never adopt a foreign turn's longer body onto this host.
  if (identityTurn && contentTurn && identityTurn !== contentTurn) {
    return identity
  }
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
    // Gateway often splits one user turn into msg-N (tools/narration) + msg-N+1
    // (final text). Emitting every hist text lane beside the live host duplicated
    // the reply under the same user (and left empty assistant:run shells around).
    if (kind === 'text' && liveLane.length > 0) {
      let merged = liveLane[0]!
      for (let i = 1; i < liveLane.length; i += 1) {
        merged = stampRow(merged, liveLane[i])
      }
      for (const histRow of histLane) {
        merged = stampRow(merged, histRow)
      }
      out.push(merged)
      continue
    }
    if (kind === 'text' && liveLane.length === 0 && histLane.length > 1) {
      let merged = histLane[0]!
      for (let i = 1; i < histLane.length; i += 1) {
        merged = stampRow(merged, histLane[i])
      }
      out.push(merged)
      continue
    }
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

/**
 * Ordinal suffix pairing must not graft a prior history assistant onto a
 * live open turn that only has the new user yet — that relocates the old
 * reply under the follow-up user (the flash/reorder bug).
 *
 * When both sides already have assistants, ordinal is unsafe without a shared
 * user identity (submit id). Length-based stampRow would then overwrite the
 * live host with the previous turn's longer body.
 */
function canOrdinalPairTurns(
  historyTurn: HermesActivityTurn,
  liveTurn: HermesActivityTurn,
): boolean {
  if (!turnsTemporallyCompatible(historyTurn, liveTurn)) return false
  const liveSubmit = readString(liveTurn.user?.payload.clientSubmitId).trim()
  const histSubmit = readString(historyTurn.user?.payload.clientSubmitId).trim()
  if (liveSubmit && histSubmit && liveSubmit !== histSubmit) return false
  const liveText = readString(liveTurn.user?.payload.text).trim()
  const histText = readString(historyTurn.user?.payload.text).trim()
  const sameOpenUserBySubmit =
    Boolean(liveSubmit) && Boolean(histSubmit) && liveSubmit === histSubmit
  const sameOpenUserByText =
    Boolean(liveText) && Boolean(histText) && liveText === histText
  const liveHasAssistantRest = liveTurn.rest.some(
    (row) => row.role === 'assistant',
  )
  const histHasAssistantRest = historyTurn.rest.some(
    (row) => row.role === 'assistant',
  )
  // Tutti / canonical primary: shared clientSubmitId.
  // Gateway echo without platform_message_id may still match by bare prompt,
  // but never graft a history assistant under a live-only user (that relocates
  // the prior reply under the follow-up question — especially same text like
  // 「继续」within seconds).
  if (liveSubmit) {
    if (sameOpenUserBySubmit) return true
    if (!histSubmit && sameOpenUserByText) {
      if (histHasAssistantRest && !liveHasAssistantRest) return false
      return true
    }
    return false
  }
  // External weak-id history (no submit on either side): text echo only.
  const sameOpenUser =
    sameOpenUserBySubmit || (!histSubmit && sameOpenUserByText)
  // Refuse grafting a *different* turn's assistant under a new live user.
  if (histHasAssistantRest && !liveHasAssistantRest && !sameOpenUser) {
    return false
  }
  // Both already have assistants: only pair on shared bare-prompt echo.
  if (histHasAssistantRest && liveHasAssistantRest && !sameOpenUser) {
    return false
  }
  return true
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

  // Ordinal suffix among leftovers. Refuse pairs that would relocate a prior
  // history assistant under a newer live user-only (open) turn.
  let hi = historyTurns.length - 1
  let li = liveTurns.length - 1
  while (hi >= 0 && li >= 0) {
    while (hi >= 0 && histMatched[hi]) hi -= 1
    while (li >= 0 && liveMatched[li]) li -= 1
    if (hi < 0 || li < 0) break
    if (!canOrdinalPairTurns(historyTurns[hi]!, liveTurns[li]!)) {
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
    // Unmatched history user-only turns that echo a live user (msg-* beside
    // user:<clientSubmitId>) used to prepend a duplicate bubble on Enter.
    if (isUserOnlyEchoOfLiveTurn(historyTurns[i]!, liveTurns)) continue
    out.push(...flattenTurn(historyTurns[i]!))
  }
  for (let i = 0; i < liveTurns.length; i += 1) {
    const stamped = stampByLiveIndex.get(i)
    if (stamped) out.push(...stamped)
    else if (!liveMatched[i]) out.push(...flattenTurn(liveTurns[i]!))
  }

  return renumber(out)
}

/** Gateway/RQ user echo of a live optimistic user — not a new turn. */
function isUserOnlyEchoOfLiveTurn(
  historyTurn: HermesActivityTurn,
  liveTurns: readonly HermesActivityTurn[],
): boolean {
  if (!historyTurn.user || historyTurn.rest.length > 0) return false
  const histUser = historyTurn.user
  // History mapping already strips Workspace::v1; compare bare prompt text.
  const histText = readString(histUser.payload.text).trim()
  const histSubmit = readString(histUser.payload.clientSubmitId).trim()
  for (const liveTurn of liveTurns) {
    const liveUser = liveTurn.user
    if (!liveUser) continue
    if (liveUser.messageId === histUser.messageId) return true
    const liveSubmit = readString(liveUser.payload.clientSubmitId).trim()
    if (histSubmit && liveSubmit && histSubmit === liveSubmit) return true
    if (
      histText &&
      histText === readString(liveUser.payload.text).trim() &&
      (isWeakHermesGatewayMessageId(histUser.messageId) ||
        histUser.messageId.startsWith('user:history:'))
    ) {
      return true
    }
  }
  return false
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
  // Gateway msg-N assistants for one user turn must share that user's turnId.
  // `turn-msg-N` per message made narration+final look like two turns and left
  // live `assistant:run_*` shells beside `msg-*` after settle.
  let openUserTurnId: string | null = null

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]
    if (!message) continue
    const role = readString(message.role).trim() || 'assistant'
    const occurredAtUnixMs = messageTimestamp(message, index)
    const parts = contentParts(message)

    if (role === 'user') {
      const messageId = durableUserId(message, agentSessionId, index)
      if (seenIds.has(messageId)) continue
      // send-stream injects `[Workspace::v1: …]` for the model; gateway
      // persists that envelope. Optimistic UI keeps the bare prompt. If we
      // leave the prefix on history rows, one send becomes two user identities
      // (plain live vs prefixed msg-*) and the list shows both. Strip at the
      // history→activity boundary — transport metadata is not the user turn.
      const text = stripAgentPreferences(
        stripWorkspaceDirective(
          parts
            .map((part) => (part.type === 'text' ? readString(part.text) : ''))
            .join('')
            .trim() || readString(message.text).trim(),
        ),
      ).trim()
      const clientSubmitId = readClientSubmitId(message)
      const isWeakUserId =
        isWeakHermesGatewayMessageId(messageId) ||
        messageId.startsWith('user:history:')

      // Same history page can hold RQ optimistic (`user:<clientId>`) and the
      // gateway `msg-*` echo — keep the durable client row only.
      if (isWeakUserId && text) {
        const hasDurableTwin = out.some(
          (row) =>
            row.role === 'user' &&
            !isWeakHermesGatewayMessageId(row.messageId) &&
            !row.messageId.startsWith('user:history:') &&
            readString(row.payload.text) === text,
        )
        if (hasDurableTwin) continue
      }
      if (clientSubmitId && text) {
        // Only absorb a trailing weak echo of this same-turn prompt — stop at
        // any non-user row so an older identical user message stays.
        for (let i = out.length - 1; i >= 0; i -= 1) {
          const row = out[i]
          if (!row || row.role !== 'user') break
          if (
            !isWeakHermesGatewayMessageId(row.messageId) &&
            !row.messageId.startsWith('user:history:')
          ) {
            break
          }
          if (readString(row.payload.text) !== text) break
          seenIds.delete(row.messageId)
          out.splice(i, 1)
        }
      }

      sequence += 1
      seenIds.add(messageId)
      const turnId = turnIdFor(message, messageId)
      openUserTurnId = turnId
      out.push({
        workspaceId,
        agentSessionId,
        messageId,
        version: sequence,
        sequence,
        turnId,
        role: 'user',
        kind: 'text',
        status: null,
        payload: {
          text,
          content: text,
          ...(clientSubmitId ? { clientSubmitId } : {}),
        },
        occurredAtUnixMs,
      })
      continue
    }

    if (role !== 'assistant' && role !== 'assistant_thinking') continue

    const baseId = durableAssistantId(message, agentSessionId, index)
    const explicitTurn = readString((message as { turnId?: unknown }).turnId).trim()
    const runId = readString(message.runId).trim()
    const turnId =
      explicitTurn ||
      (runId ? `turn-${runId}` : '') ||
      openUserTurnId ||
      turnIdFor(message, baseId)
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
