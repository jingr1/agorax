/**
 * Group chat round-robin runner.
 *
 * Aligned with Hermes Desktop Bot Mode:
 *   - A USER send (triggerRoomRun) ignites at most one bounded drive.
 *   - The 5s tick only harvests stranded replies / expires stale turns —
 *     it never re-drives on agent watermark lag (that was the infinite loop).
 *   - Caps: 3 rounds, 10 messages, 2 continuations per user-send budget.
 *   - #93129 sticky holds: "stop @member" / "@all stop"; room pause holds all.
 *   - Publishes room events on chat-event-bus.
 */
import { publishChatEvent } from '../chat-event-bus'
import { ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import {
  GROUP_CHAT_HISTORY_LIMIT,
  GROUP_CHAT_MAX_CONTINUATIONS,
  GROUP_CHAT_MAX_MESSAGES,
  GROUP_CHAT_MAX_ROUNDS,
  GROUP_DUPLICATE_APPEND_WINDOW_MS,
  GROUP_HARVEST_INTERVAL_MS,
  GROUP_HARVEST_MAX_TRIES,
  GROUP_RUNNER_ERROR_COOLDOWN_MS,
  GROUP_RUNNER_TICK_MS,
  GROUP_TURN_HARD_CAP_MS,
} from './constants'
import {
  applyGroupHoldDirective,
  heldMemberWatermarkAdvance,
  holdAllMemberKeys,
} from './member-holds'
import {
  expirePendingTurns,
  getLatestMessages,
  getRoom,
  getWatermark,
  insertMessage,
  listParticipants,
  listRooms,
  setWatermark,
  toGroupMember,
  toHealedGroupMember,
  updateRoom,
} from './room-store'
import { executeMemberTurn } from './turn-executor'
import { buildTurnContext } from './prompt-builder'
import { resolveRoomCwd } from './resolve-room-cwd'
import {
  expandMentionTargets,
  groupMemberKey,
  parseMentions,
} from './mention-routing'
import { openAttentionForRoom } from './pending-turn-service'
import {
  hasActionableUnreadForMember,
  isGroupPassText,
  isGroupTranscriptBusy,
  pickGroupTurnReply,
  resolveGroupResponders,
  rotateGroupSpeakers,
  unaddressedGroupMentions,
} from './responder-utils'
import {
  bumpRoomEpoch,
  clearRoomErrorCooldown,
  clearRoomHolds,
  clearStranded,
  clearTurnInFlight,
  expireStaleInFlight,
  getInFlightMembers,
  getRoomEpoch,
  getRoomHolds,
  getRoomRunnerState,
  getStranded,
  hasStranded,
  isMemberHeld,
  isRoomInErrorCooldown,
  isRoomRunning,
  listStrandedMembers,
  markHoldNoted,
  setLastRunAt,
  setRoomErrorCooldown,
  setRoomHolds,
  setRoomRunning,
  setStranded,
  setTurnInFlight,
  shouldLogRoomError,
} from './runner-state'
import { getMemberSessionMessages } from './agent-session-manager'
import { getContextForMember, maybeSummarizeRoom } from './summaries'
import type { GroupMember, GroupTurnResult, Room, RoomMessage } from './types'

/** Prefer an explicit Hermes profile; never pass managed agent ids as gateway profiles. */
function pickSummaryProfile(
  members: Array<GroupMember>,
  preferred?: string | null,
): string | undefined {
  const hermesProfiles = members
    .filter((m) => m.runtime === 'hermes')
    .map((m) => m.profile?.trim())
    .filter((p): p is string => Boolean(p))
  if (preferred?.trim() && hermesProfiles.includes(preferred.trim())) {
    return preferred.trim()
  }
  return hermesProfiles[0]
}

type RunnerControl = {
  timer: ReturnType<typeof setInterval> | null
  busy: boolean
}

/** HMR-safe singleton so dispose/start share one timer across module reloads. */
function getRunnerControl(): RunnerControl {
  const g = globalThis as Record<string, unknown>
  const key = '__group_chat_runner_control__'
  if (!g[key]) {
    g[key] = { timer: null, busy: false } satisfies RunnerControl
  }
  return g[key] as RunnerControl
}

/** Vite SSR HMR closes the module runner; stale timers must stop immediately. */
function isViteRunnerClosedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /Vite module runner has been closed/i.test(msg)
}

function isTransientGatewayError(message: string): boolean {
  return /fetch failed|Could not verify .+ group session|ECONNREFUSED|ENOTFOUND|network error|timeout/i.test(
    message,
  )
}

function handleRunnerFatalError(error: unknown, context: string): boolean {
  if (!isViteRunnerClosedError(error)) return false
  console.warn(
    `[group-chat-runner] ${context}: Vite module runner closed; stopping stale timer`,
  )
  stopGroupChatRunner()
  return true
}

function logRoomError(roomId: string, message: string): void {
  if (!shouldLogRoomError(roomId, message, GROUP_RUNNER_ERROR_COOLDOWN_MS)) {
    return
  }
  console.error(`[group-chat-runner] room ${roomId} error:`, message)
}

export function startGroupChatRunner(): void {
  const control = getRunnerControl()
  if (control.timer) return
  // Apply any pending collab.db migrations before the first tick.
  ensureCollabDb()
  // Diagnostic: confirm the resolved db path and schema at startup.
  try {
    const dbPath = getCollabDbPath()
    const db = openSqliteDatabase(dbPath, true)
    const cols = db
      .prepare('PRAGMA table_info(room_participants)')
      .all()
      .map((r: any) => r.name)
    db.close()
    console.log(
      `[group-chat-runner] dbPath=${dbPath} room_participants columns=${cols.join(',')}`,
    )
  } catch (e) {
    console.error('[group-chat-runner] schema probe error:', e)
  }
  control.timer = setInterval(async () => {
    if (control.busy) return
    control.busy = true
    try {
      await tickAllRooms()
    } catch (error) {
      if (handleRunnerFatalError(error, 'tick')) return
      console.error(
        '[group-chat-runner] tick error:',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      control.busy = false
    }
  }, GROUP_RUNNER_TICK_MS)
  console.log('[group-chat-runner] started')
}

export function stopGroupChatRunner(): void {
  const control = getRunnerControl()
  if (control.timer) {
    clearInterval(control.timer)
    control.timer = null
  }
  control.busy = false
}

// Dev HMR: clear the interval from the dying module graph so a closed Vite
// runner cannot keep ticking and flood the console every GROUP_RUNNER_TICK_MS.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopGroupChatRunner()
  })
}

export function isGroupChatRunnerRunning(): boolean {
  return getRunnerControl().timer !== null
}

/**
 * Fire-and-forget trigger: immediately start driving one room epoch without
 * awaiting the result. Mirrors Desktop Bot Mode's sendToGroupChat ignition.
 * Guards against re-entrant execution so only one drive owns the room.
 */
export function triggerRoomRun(roomId: string): void {
  void (async () => {
    try {
      // Human message ignition should not wait out a gateway cooldown — clear
      // it so ensure+verify can run immediately after the user speaks.
      clearRoomErrorCooldown(roomId)
      await runRoomInternal(roomId)
    } catch (error) {
      if (handleRunnerFatalError(error, `trigger ${roomId}`)) return
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      if (isTransientGatewayError(message)) {
        setRoomErrorCooldown(roomId, GROUP_RUNNER_ERROR_COOLDOWN_MS)
      }
      console.error(`[group-chat-runner] trigger ${roomId} error:`, message)
    }
  })()
}

/**
 * Apply #93129 hold/release from a human message. Call before triggerRoomRun.
 */
export function applyUserHoldDirective(input: {
  roomId: string
  content: string
  messageId: string
  members: Array<GroupMember>
}): void {
  const keys = input.members.map(groupMemberKey)
  const parsed = parseMentions(input.content, input.members)
  const next = applyGroupHoldDirective(
    getRoomHolds(input.roomId),
    { everyone: parsed.everyone, mentioned: parsed.mentioned },
    input.content,
    { at: Date.now(), byMessageId: input.messageId },
    keys,
  )
  setRoomHolds(input.roomId, next)
}

/**
 * Pause a room: bump epoch (abort in-flight drive at next boundary), hold
 * every agent, set state=paused. Tick may still harvest stranded replies.
 */
export function pauseRoom(roomId: string): ReturnType<typeof getRoom> {
  const room = getRoom(roomId)
  if (!room) return null
  const members = listParticipants(roomId)
    .filter((p) => p.kind === 'agent' && !p.removedAt)
    .map((p) => toHealedGroupMember(p))
  bumpRoomEpoch(roomId)
  setRoomRunning(roomId, false)
  setRoomHolds(
    roomId,
    holdAllMemberKeys(getRoomHolds(roomId), members.map(groupMemberKey), {
      at: Date.now(),
      byMessageId: null,
    }),
  )
  const updated = updateRoom(roomId, {
    state: 'paused',
    updatedAt: Date.now(),
  })
  publishChatEvent('group_chat_cancelled', { roomId })
  console.log(`[group-chat-runner] room ${roomId} paused`)
  return updated
}

/**
 * Resume a paused room. Clears sticky holds by default (UI Resume button).
 * Does not auto-drive — wait for the next human message / triggerRoomRun.
 */
export function resumeRoom(
  roomId: string,
  opts?: { clearHolds?: boolean },
): ReturnType<typeof getRoom> {
  const room = getRoom(roomId)
  if (!room) return null
  if (opts?.clearHolds !== false) clearRoomHolds(roomId)
  const updated = updateRoom(roomId, {
    state: 'active',
    updatedAt: Date.now(),
  })
  console.log(`[group-chat-runner] room ${roomId} resumed`)
  return updated
}

/**
 * Background tick: Bot Mode alignment — harvest stranded replies only.
 * Never starts a new drive from agent watermark lag.
 */
export async function tickAllRooms(): Promise<void> {
  ensureCollabDb()
  const rooms = listRooms()
  for (const room of rooms) {
    if (room.state === 'disbanded' || room.state === 'complete') continue
    if (isRoomInErrorCooldown(room.id)) continue
    try {
      await maintainRoom(room.id)
    } catch (error) {
      if (handleRunnerFatalError(error, `room ${room.id}`)) return
      const message = error instanceof Error ? error.message : String(error)
      if (isTransientGatewayError(message)) {
        setRoomErrorCooldown(room.id, GROUP_RUNNER_ERROR_COOLDOWN_MS)
      }
      logRoomError(room.id, message)
    }
  }
}

export async function runRoom(room: Room): Promise<void> {
  return runRoomInternal(room.id)
}

async function runRoomInternal(roomId: string): Promise<void> {
  if (isRoomRunning(roomId)) return
  if (isRoomInErrorCooldown(roomId)) return
  const room = getRoom(roomId)
  // Paused / needs_human / complete rooms do not start new drives.
  if (!room || room.state !== 'active') return
  setRoomRunning(roomId, true)

  try {
    await driveRoom(roomId)
    clearRoomErrorCooldown(roomId)
  } finally {
    setRoomRunning(roomId, false)
  }
}

/** Tick maintenance: stranded harvest + expiry. No round-robin drive. */
async function maintainRoom(roomId: string): Promise<void> {
  if (isRoomRunning(roomId)) return
  expireStaleInFlight(roomId, GROUP_TURN_HARD_CAP_MS)
  expirePendingTurns(Date.now() - 30 * 60 * 1000)

  const room = getRoom(roomId)
  if (!room || room.state === 'disbanded' || room.state === 'complete') return

  const participants = listParticipants(roomId).filter(
    (p) => p.kind === 'agent' && !p.removedAt,
  )
  if (participants.length === 0) return
  const members = participants.map((p) => toHealedGroupMember(p))

  for (const member of members) {
    await harvestStrandedReply(room, member)
  }

  if (listStrandedMembers(roomId).length > 0) {
    void harvestStrandedUntilSettled(roomId, members)
  }
}

async function driveRoom(roomId: string): Promise<void> {
  setLastRunAt(roomId, Date.now())
  expireStaleInFlight(roomId, GROUP_TURN_HARD_CAP_MS)
  expirePendingTurns(Date.now() - 30 * 60 * 1000)

  const room = getRoom(roomId)
  if (!room || room.state !== 'active') return

  const participants = listParticipants(roomId).filter(
    (p) => p.kind === 'agent' && !p.removedAt,
  )
  if (participants.length === 0) return

  const members = participants.map((p) => toHealedGroupMember(p))
  const allMessages = getLatestMessages(roomId, { limit: 200 })

  // Summarize if needed (Hermes throwaway session — never a managed agent id).
  await maybeSummarizeRoom(roomId, {
    profile: pickSummaryProfile(members),
  })

  // Stranded reply harvest: check any timed-out member for a finished reply.
  for (const member of members) {
    await harvestStrandedReply(room, member)
  }

  // If any member is still in flight after harvest, don't start new turns.
  const stillInFlight = getInFlightMembers(roomId)
  if (stillInFlight.length > 0) return

  // Only drive when a responder has actionable unread (human / @them / @all),
  // not merely sibling agent chatter past their watermark.
  const responders = resolveGroupResponders(allMessages, members)
  const hasActionableDelta = responders.some((member) => {
    const watermark = getWatermark(roomId, member.participantId)
    const unread = allMessages.slice(watermark)
    return hasActionableUnreadForMember(unread, member, members)
  })
  if (!hasActionableDelta) {
    // Still may have stranded work; keep background harvest going.
    if (listStrandedMembers(roomId).length > 0) {
      void harvestStrandedUntilSettled(roomId, members)
    }
    return
  }

  // Drive one conversation epoch.
  const startEpoch = bumpRoomEpoch(roomId)
  const cwd = resolveRoomCwd(room)
  await runGroupChatRounds(room, members, startEpoch, cwd)
}

async function runGroupChatRounds(
  room: Room,
  members: Array<GroupMember>,
  startEpoch: number,
  cwd: string | null,
): Promise<void> {
  const messages = getLatestMessages(room.id, { limit: 200 })
  let posted = 0
  let continuations = 0
  let exitKind: 'settled' | 'capped' = 'settled'

  const isCurrent = () => getRoomEpoch(room.id) === startEpoch

  for (let round = 0; round < GROUP_CHAT_MAX_ROUNDS; round++) {
    // Deliver any replies that finished after their turn timed out —
    // every member, not just this round's responders (Bot Mode).
    for (const member of members) {
      if (!isCurrent()) return
      await harvestStrandedReply(room, member)
    }

    const roomLog = getLatestMessages(room.id, { limit: 200 })
    const inFlight = getInFlightMembers(room.id)
    // Skip members still stranded (gateway turn still running). Re-prompting
    // them would interrupt the long work harvest exists to protect.
    const responders = rotateGroupSpeakers(
      resolveGroupResponders(roomLog, members),
      round,
    ).filter(
      (m) => !inFlight.includes(groupMemberKey(m)) && !hasStranded(room.id, m),
    )

    let spokeThisRound = 0

    for (const member of responders) {
      if (!isCurrent() || posted >= GROUP_CHAT_MAX_MESSAGES) {
        if (isCurrent()) exitKind = 'capped'
        finishDrive(room, members, exitKind)
        return
      }

      const watermark = getWatermark(room.id, member.participantId)
      if (roomLog.length <= watermark) continue

      // #93129: held member — consume delta once, never take a turn.
      if (isMemberHeld(room.id, member)) {
        const advance = heldMemberWatermarkAdvance(watermark, roomLog.length)
        if (advance !== null) {
          setWatermark(room.id, member.participantId, advance)
        }
        const key = groupMemberKey(member)
        const entry = getRoomHolds(room.id)[key]
        if (entry && !entry.noted) {
          markHoldNoted(room.id, key)
          publishChatEvent('group_chat_held', {
            roomId: room.id,
            member: member.displayName,
          })
        }
        continue
      }

      const unread = roomLog.slice(watermark)
      // Sibling agent posts (incl. failure notes) without @this member are
      // noise — advance watermark so we don't re-prompt on every room bubble.
      if (!hasActionableUnreadForMember(unread, member, members)) {
        setWatermark(room.id, member.participantId, roomLog.length)
        continue
      }

      const delta = unread.slice(-GROUP_CHAT_HISTORY_LIMIT)
      if (delta.length === 0) continue

      const turnResult = await runMemberTurn(room, member, delta, members, cwd)

      if (turnResult.kind === 'blocked') {
        // Human gate was raised; stop the drive.
        finishDrive(room, members, 'settled')
        return
      }

      if (turnResult.kind === 'reply') {
        const isDuplicate = isDuplicateAppend(
          roomLog[roomLog.length - 1],
          member,
          turnResult.text,
        )
        if (!isDuplicate) {
          const newMessage = insertMessage({
            roomId: room.id,
            senderKind: 'agent',
            senderParticipantId: member.participantId,
            senderName: member.displayName,
            content: turnResult.text,
            mentions: expandMentionTargets(
              parseMentions(turnResult.text, members),
              room.id,
              members,
            ),
            runId: turnResult.runId ?? null,
          })
          maybeOpenHumanAttentionFromMessage(
            room.id,
            newMessage,
            member.participantId,
          )
          posted += 1
          spokeThisRound += 1
          setWatermark(
            room.id,
            member.participantId,
            getLatestMessages(room.id, { limit: 200 }).length,
          )
          publishChatEvent('group_chat_reply', {
            roomId: room.id,
            messageId: newMessage.id,
            member: member.displayName,
            text: turnResult.text,
          })
          await maybeSummarizeRoom(room.id, {
            profile: pickSummaryProfile(members, member.profile),
          })
          continue
        }
      }

      if (turnResult.kind === 'pass') {
        setWatermark(room.id, member.participantId, roomLog.length)
      }

      // Timeout: advance watermark (don't re-prompt same delta) + strand so
      // the finished reply can be harvested late. Failed: advance + post the
      // reason into the room so quota/API errors are not silent.
      if (turnResult.kind === 'timeout') {
        setWatermark(room.id, member.participantId, roomLog.length)
        setStranded(room.id, member, {
          before: turnResult.before,
          sessionId: turnResult.sessionId,
        })
        publishChatEvent('group_chat_failed', {
          roomId: room.id,
          member: member.displayName,
          reason: 'turn timed out — will harvest late reply if it finishes',
        })
      } else if (turnResult.kind === 'failed') {
        const failText = `⚠️ ${member.displayName} failed: ${turnResult.reason}`
        const failMessage = insertMessage({
          roomId: room.id,
          senderKind: 'agent',
          senderParticipantId: member.participantId,
          senderName: member.displayName,
          content: failText,
          mentions: [],
        })
        // Watermark must include the failure note. Advancing only to the
        // pre-insert length makes the next round treat the failure as unseen
        // delta and re-prompt the same member (@all → duplicate error spam).
        setWatermark(
          room.id,
          member.participantId,
          getLatestMessages(room.id, { limit: 200 }).length,
        )
        // Publish as a room message so the live UI refetches (group_chat_failed
        // alone was ignored by the rooms screen until a full reload).
        publishChatEvent('group_chat_message', {
          roomId: room.id,
          messageId: failMessage.id,
          member: member.displayName,
          text: failText,
        })
        publishChatEvent('group_chat_failed', {
          roomId: room.id,
          member: member.displayName,
          reason: turnResult.reason,
        })
      }
    }

    if (spokeThisRound === 0) {
      const pendingKeys = unaddressedGroupMentions(
        getLatestMessages(room.id, { limit: 200 }),
        members,
      )
      // Quiet round with nothing left to chase → settle. Do not burn the
      // remaining MAX_ROUNDS re-driving the same delta.
      if (pendingKeys.length === 0) {
        finishDrive(room, members, 'settled')
        return
      }
      continuations += 1
      if (
        continuations > GROUP_CHAT_MAX_CONTINUATIONS ||
        posted >= GROUP_CHAT_MAX_MESSAGES
      ) {
        finishDrive(room, members, 'capped')
        return
      }
      const citedMembers = members.filter((m) =>
        pendingKeys.includes(groupMemberKey(m)),
      )
      const stillInFlight = getInFlightMembers(room.id)
      const continuationResponders = citedMembers.filter(
        (m) =>
          !stillInFlight.includes(groupMemberKey(m)) &&
          !hasStranded(room.id, m) &&
          !isMemberHeld(room.id, m),
      )
      for (const member of continuationResponders) {
        if (
          !isCurrent() ||
          posted >= GROUP_CHAT_MAX_MESSAGES ||
          continuations > GROUP_CHAT_MAX_CONTINUATIONS
        ) {
          finishDrive(room, members, 'capped')
          return
        }
        const roomLog2 = getLatestMessages(room.id, { limit: 200 })
        const watermark = getWatermark(room.id, member.participantId)
        const unread = roomLog2.slice(watermark)
        // Unaddressed @ may sit behind an already-advanced watermark (sibling
        // noise catch-up). Prefer unread when present; else recent history.
        const delta =
          unread.length > 0
            ? unread.slice(-GROUP_CHAT_HISTORY_LIMIT)
            : roomLog2.slice(-GROUP_CHAT_HISTORY_LIMIT)
        if (delta.length === 0) continue
        const turnResult = await runMemberTurn(room, member, delta, members, cwd)
        if (turnResult.kind === 'reply') {
          const newMessage = insertMessage({
            roomId: room.id,
            senderKind: 'agent',
            senderParticipantId: member.participantId,
            senderName: member.displayName,
            content: turnResult.text,
            mentions: expandMentionTargets(
              parseMentions(turnResult.text, members),
              room.id,
              members,
            ),
            runId: turnResult.runId ?? null,
          })
          maybeOpenHumanAttentionFromMessage(
            room.id,
            newMessage,
            member.participantId,
          )
          posted += 1
          setWatermark(
            room.id,
            member.participantId,
            getLatestMessages(room.id, { limit: 200 }).length,
          )
          publishChatEvent('group_chat_reply', {
            roomId: room.id,
            messageId: newMessage.id,
            member: member.displayName,
            text: turnResult.text,
          })
          await maybeSummarizeRoom(room.id, {
            profile: pickSummaryProfile(members, member.profile),
          })
        } else if (turnResult.kind === 'timeout') {
          setWatermark(room.id, member.participantId, roomLog2.length)
          setStranded(room.id, member, {
            before: turnResult.before,
            sessionId: turnResult.sessionId,
          })
          publishChatEvent('group_chat_failed', {
            roomId: room.id,
            member: member.displayName,
            reason: 'turn timed out — will harvest late reply if it finishes',
          })
        } else if (turnResult.kind === 'pass') {
          setWatermark(room.id, member.participantId, roomLog2.length)
        } else if (turnResult.kind === 'failed') {
          const failText = `⚠️ ${member.displayName} failed: ${turnResult.reason}`
          const failMessage = insertMessage({
            roomId: room.id,
            senderKind: 'agent',
            senderParticipantId: member.participantId,
            senderName: member.displayName,
            content: failText,
            mentions: [],
          })
          setWatermark(
            room.id,
            member.participantId,
            getLatestMessages(room.id, { limit: 200 }).length,
          )
          publishChatEvent('group_chat_message', {
            roomId: room.id,
            messageId: failMessage.id,
            member: member.displayName,
            text: failText,
          })
          publishChatEvent('group_chat_failed', {
            roomId: room.id,
            member: member.displayName,
            reason: turnResult.reason,
          })
        }
      }
    }
  }

  finishDrive(room, members, exitKind)
}

async function runMemberTurn(
  room: Room,
  member: GroupMember,
  delta: Array<RoomMessage>,
  members: Array<GroupMember>,
  cwd: string | null,
): Promise<GroupTurnResult> {
  const { summary } = getContextForMember(room.id)
  const prompt = buildTurnContext(
    room.title,
    members,
    member,
    delta,
    summary,
    cwd,
  )

  publishChatEvent('group_chat_turn_started', {
    roomId: room.id,
    member: member.displayName,
  })

  setTurnInFlight(room.id, member, 'pending')
  let result: GroupTurnResult | undefined
  try {
    result = await executeMemberTurn({
      roomId: room.id,
      roomTitle: room.title,
      member,
      prompt,
      cwd,
    })
    return result
  } finally {
    clearTurnInFlight(room.id, member)
    publishChatEvent('group_chat_turn_ended', {
      roomId: room.id,
      member: member.displayName,
      result: result?.kind ?? 'unknown',
    })
  }
}

/**
 * Post a timed-out member's finished reply into the room, if it landed after
 * we stopped waiting. Bot Mode: late, never lost.
 */
async function harvestStrandedReply(
  room: Room,
  member: GroupMember,
): Promise<boolean> {
  // Managed runtimes have no Hermes session transcript to harvest.
  if (member.runtime !== 'hermes') {
    const marker = getStranded(room.id, member)
    if (marker) clearStranded(room.id, member)
    return false
  }

  const marker = getStranded(room.id, member)
  if (!marker) {
    // Expire very old in-flight markers (hard cap) even without stranded.
    const state = getRoomRunnerState(room.id)
    const turn = state.inFlight.get(groupMemberKey(member))
    if (turn && Date.now() - turn.startedAt > GROUP_TURN_HARD_CAP_MS) {
      clearTurnInFlight(room.id, member)
    }
    return false
  }

  const { messages } = await getMemberSessionMessages(room.id, member)
  if (messages.length === 0) {
    // Session unreachable — leave marker for next boundary.
    return false
  }

  if (isGroupTranscriptBusy(messages, marker.before)) {
    // Still grinding — keep waiting.
    return false
  }

  // Done (or dead): consume the marker either way.
  clearStranded(room.id, member)

  if (messages.length <= marker.before) {
    return false
  }

  const reply = pickGroupTurnReply(
    messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
    })),
    marker.before,
  )

  if (!reply || isGroupPassText(reply)) {
    return false
  }

  const roomLog = getLatestMessages(room.id, { limit: 200 })
  if (isDuplicateAppend(roomLog[roomLog.length - 1], member, reply)) {
    return false
  }

  const participants = listParticipants(room.id)
    .filter((p) => !p.removedAt)
    .map((p) => toGroupMember(p))
  const newMessage = insertMessage({
    roomId: room.id,
    senderKind: 'agent',
    senderParticipantId: member.participantId,
    senderName: member.displayName,
    content: reply,
    mentions: expandMentionTargets(
      parseMentions(reply, participants),
      room.id,
      participants,
    ),
  })
  maybeOpenHumanAttentionFromMessage(
    room.id,
    newMessage,
    member.participantId,
  )
  setWatermark(room.id, member.participantId, roomLog.length + 1)
  publishChatEvent('group_chat_reply', {
    roomId: room.id,
    messageId: newMessage.id,
    member: member.displayName,
    text: reply,
  })
  console.log(
    `[group-chat-runner] harvested stranded reply from ${member.displayName} (${reply.slice(0, 80)})`,
  )
  return true
}

/**
 * Bounded background harvest after a drive settles (Bot Mode:
 * harvestStrandedUntilSettled — 5s × 60 ≈ 5 min).
 */
async function harvestStrandedUntilSettled(
  roomId: string,
  members: Array<GroupMember>,
): Promise<void> {
  for (let attempt = 0; attempt < GROUP_HARVEST_MAX_TRIES; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, GROUP_HARVEST_INTERVAL_MS),
    )
    if (isRoomRunning(roomId)) return
    const room = getRoom(roomId)
    if (!room || room.state !== 'active') return
    if (listStrandedMembers(roomId).length === 0) return

    for (const member of members) {
      if (!hasStranded(roomId, member)) continue
      try {
        await harvestStrandedReply(room, member)
      } catch (error) {
        console.warn(
          `[group-chat-runner] harvest ${member.displayName}:`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}

function isDuplicateAppend(
  lastEntry: RoomMessage | undefined,
  member: GroupMember,
  text: string,
): boolean {
  if (!lastEntry) return false
  if (lastEntry.senderKind !== 'agent') return false
  if (lastEntry.senderName !== member.displayName) return false
  if (lastEntry.content !== text) return false
  return Date.now() - lastEntry.createdAt < GROUP_DUPLICATE_APPEND_WINDOW_MS
}

/** When an agent @mentions a human, open a pending turn (P5). */
function maybeOpenHumanAttentionFromMessage(
  roomId: string,
  message: RoomMessage,
  requestedBy: string,
): void {
  if (message.autoHandoff) return
  const humanTargets = message.mentions.filter((m) => m.type === 'human')
  if (humanTargets.length === 0) return
  void openAttentionForRoom({
    roomId,
    requestedBy,
    kind: 'needs_input',
    reason: message.content.slice(0, 500),
    messageId: message.id,
  }).catch((error) => {
    console.warn(
      '[group-chat-runner] openAttentionForRoom failed',
      error instanceof Error ? error.message : String(error),
    )
  })
}

function finishDrive(
  room: Room,
  members: Array<GroupMember>,
  kind: 'settled' | 'capped',
): void {
  publishChatEvent(
    kind === 'settled' ? 'group_chat_settled' : 'group_chat_capped',
    {
      roomId: room.id,
    },
  )
  // Poll for late replies that outlived the turn loop.
  if (listStrandedMembers(room.id).length > 0) {
    void harvestStrandedUntilSettled(room.id, members)
  }
}
