/**
 * Runner state tracking for group chat.
 *
 * Tracks in-flight turns, room epochs, stranded replies, and #93129 member
 * holds so the runner can avoid double-dispatching a member and can harvest
 * late replies safely.
 */
import { groupMemberKey } from './mention-routing'
import type { GroupHoldStamp } from './member-holds'
import type { GroupMember } from './types'
import { randomUUID } from 'node:crypto'
import type { ControlPlaneStateStore, ExecutionLease } from '../control-plane-state'

let stateStore: ControlPlaneStateStore | null = null
const leaseOwner = randomUUID()

export function configureRoomRunnerStateStore(store: ControlPlaneStateStore): void {
  stateStore = store
  getState().clear()
}

type MemberTurnState = {
  startedAt: number
  sessionId: string
  memberKey: string
  recovered?: boolean
  lease?: ExecutionLease
  before?: number
  runId?: string
}

/** Baseline for a turn that timed out while the gateway may still be working. */
export type StrandedMarker = {
  before: number
  sessionId: string
  startedAt: number
}

type RoomRunnerState = {
  epoch: number
  inFlight: Map<string, MemberTurnState>
  stranded: Map<string, StrandedMarker>
  lastRunAt: number
  running: boolean
  /** Skip driveRoom until this timestamp after a transient gateway failure. */
  errorCooldownUntil: number
  /** Last error message we rate-limited for this room. */
  lastErrorMessage: string | null
  lastErrorLoggedAt: number
  /** #93129 sticky per-member stop holds (room-scoped). */
  holds: Record<string, GroupHoldStamp>
}

const STATE_KEY = '__group_chat_runner_state__'

type RoomSnapshot = Omit<RoomRunnerState, 'inFlight' | 'stranded'> & {
  inFlight: Array<[string, MemberTurnState]>
  stranded: Array<[string, StrandedMarker]>
}

function persistRoom(roomId: string): void {
  const state = getState().get(roomId)
  if (state) stateStore?.write('room-runner', roomId, {
    ...state, inFlight: [...state.inFlight], stranded: [...state.stranded],
  })
}

function getState(): Map<string, RoomRunnerState> {
  const g = globalThis as Record<string, unknown>
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = new Map<string, RoomRunnerState>()
  }
  return g[STATE_KEY] as Map<string, RoomRunnerState>
}

export function getRoomRunnerState(roomId: string): RoomRunnerState {
  const state = getState()
  if (!state.has(roomId)) {
    const snapshot = stateStore?.read<RoomSnapshot>('room-runner', roomId)
    if (snapshot) state.set(roomId, { ...snapshot, running: false,
      inFlight: new Map(snapshot.inFlight.map(([key, turn]) => [key, { ...turn, recovered: true }])),
      stranded: new Map([...snapshot.stranded, ...snapshot.inFlight
        .filter(([, turn]) => turn.before !== undefined && turn.sessionId !== 'pending')
        .map(([key, turn]): [string, StrandedMarker] => [key, { before: turn.before!, sessionId: turn.sessionId, startedAt: turn.startedAt }])]),
    })
  }
  if (!state.has(roomId)) {
    state.set(roomId, {
      epoch: 0,
      inFlight: new Map(),
      stranded: new Map(),
      lastRunAt: 0,
      running: false,
      errorCooldownUntil: 0,
      lastErrorMessage: null,
      lastErrorLoggedAt: 0,
      holds: {},
    })
  }
  const rs = state.get(roomId)!
  // HMR / older process state may lack fields — hydrate in place.
  if (!rs.stranded) rs.stranded = new Map()
  if (typeof rs.errorCooldownUntil !== 'number') rs.errorCooldownUntil = 0
  if (rs.lastErrorMessage === undefined) rs.lastErrorMessage = null
  if (typeof rs.lastErrorLoggedAt !== 'number') rs.lastErrorLoggedAt = 0
  if (!rs.holds || typeof rs.holds !== 'object') rs.holds = {}
  return rs
}

export function getRoomHolds(roomId: string): Record<string, GroupHoldStamp> {
  return getRoomRunnerState(roomId).holds
}

export function setRoomHolds(
  roomId: string,
  holds: Record<string, GroupHoldStamp>,
): void {
  getRoomRunnerState(roomId).holds = holds
  persistRoom(roomId)
}

export function clearRoomHolds(roomId: string): void {
  getRoomRunnerState(roomId).holds = {}
  persistRoom(roomId)
}

export function isMemberHeld(roomId: string, member: GroupMember): boolean {
  return Boolean(getRoomHolds(roomId)[groupMemberKey(member)])
}

export function markHoldNoted(roomId: string, memberKey: string): void {
  const holds = getRoomHolds(roomId)
  const entry = holds[memberKey]
  if (!entry || entry.noted) return
  setRoomHolds(roomId, {
    ...holds,
    [memberKey]: { ...entry, noted: true },
  })
}

export function isRoomInErrorCooldown(
  roomId: string,
  now = Date.now(),
): boolean {
  return getRoomRunnerState(roomId).errorCooldownUntil > now
}

export function setRoomErrorCooldown(
  roomId: string,
  cooldownMs: number,
  now = Date.now(),
): void {
  getRoomRunnerState(roomId).errorCooldownUntil = now + cooldownMs
  persistRoom(roomId)
}

export function clearRoomErrorCooldown(roomId: string): void {
  const rs = getRoomRunnerState(roomId)
  rs.errorCooldownUntil = 0
  rs.lastErrorMessage = null
  rs.lastErrorLoggedAt = 0
  persistRoom(roomId)
}

/**
 * Rate-limit identical room error logs. Returns true when the caller should
 * print (first occurrence or after `minIntervalMs`).
 */
export function shouldLogRoomError(
  roomId: string,
  message: string,
  minIntervalMs: number,
  now = Date.now(),
): boolean {
  const rs = getRoomRunnerState(roomId)
  if (
    rs.lastErrorMessage === message &&
    now - rs.lastErrorLoggedAt < minIntervalMs
  ) {
    return false
  }
  rs.lastErrorMessage = message
  rs.lastErrorLoggedAt = now
  return true
}

export function bumpRoomEpoch(roomId: string): number {
  const rs = getRoomRunnerState(roomId)
  rs.epoch += 1
  persistRoom(roomId)
  return rs.epoch
}

export function getRoomEpoch(roomId: string): number {
  return getRoomRunnerState(roomId).epoch
}

export function isRoomRunning(roomId: string): boolean {
  return getRoomRunnerState(roomId).running
}

export function setRoomRunning(roomId: string, running: boolean): void {
  getRoomRunnerState(roomId).running = running
  persistRoom(roomId)
}

export function setTurnInFlight(
  roomId: string,
  member: GroupMember,
  sessionId: string,
): boolean {
  const rs = getRoomRunnerState(roomId)
  const lease = stateStore?.claim({ namespace: 'group-turn', key: `${roomId}:${groupMemberKey(member)}`, groupId: roomId, owner: leaseOwner, globalLimit: Number.MAX_SAFE_INTEGER, groupLimit: Number.MAX_SAFE_INTEGER, ttlMs: 30_000 })
  if (stateStore && !lease) return false
  rs.inFlight.set(groupMemberKey(member), {
    startedAt: Date.now(),
    sessionId,
    memberKey: groupMemberKey(member),
    ...(lease ? { lease } : {}),
  })
  persistRoom(roomId)
  return true
}

export function clearTurnInFlight(roomId: string, member: GroupMember): void {
  const rs = getRoomRunnerState(roomId)
  const lease = rs.inFlight.get(groupMemberKey(member))?.lease
  if (lease) stateStore?.release(lease)
  rs.inFlight.delete(groupMemberKey(member))
  persistRoom(roomId)
}

export function updateTurnInFlight(roomId: string, member: GroupMember, input: { sessionId?: string; before?: number; runId?: string }): void {
  const turn = getRoomRunnerState(roomId).inFlight.get(groupMemberKey(member))
  if (!turn) return
  Object.assign(turn, input)
  persistRoom(roomId)
}

export function isTurnInFlight(roomId: string, member: GroupMember): boolean {
  const rs = getRoomRunnerState(roomId)
  return rs.inFlight.has(groupMemberKey(member))
}

export function getInFlightMembers(roomId: string): Array<string> {
  return [...getRoomRunnerState(roomId).inFlight.keys()]
}

export function setStranded(
  roomId: string,
  member: GroupMember,
  marker: Omit<StrandedMarker, 'startedAt'> & { startedAt?: number },
): void {
  const rs = getRoomRunnerState(roomId)
  rs.stranded.set(groupMemberKey(member), {
    before: marker.before,
    sessionId: marker.sessionId,
    startedAt: marker.startedAt ?? Date.now(),
  })
  persistRoom(roomId)
}

export function clearStranded(roomId: string, member: GroupMember): void {
  getRoomRunnerState(roomId).stranded.delete(groupMemberKey(member))
  persistRoom(roomId)
}

export function getStranded(
  roomId: string,
  member: GroupMember,
): StrandedMarker | undefined {
  return getRoomRunnerState(roomId).stranded.get(groupMemberKey(member))
}

export function hasStranded(roomId: string, member: GroupMember): boolean {
  return getRoomRunnerState(roomId).stranded.has(groupMemberKey(member))
}

export function listStrandedMembers(roomId: string): Array<string> {
  return [...getRoomRunnerState(roomId).stranded.keys()]
}

export function setLastRunAt(roomId: string, at: number): void {
  getRoomRunnerState(roomId).lastRunAt = at
  persistRoom(roomId)
}

export function getLastRunAt(roomId: string): number {
  return getRoomRunnerState(roomId).lastRunAt
}

/**
 * Remove in-flight turns that have exceeded the hard cap.
 */
export function expireStaleInFlight(
  roomId: string,
  hardCapMs: number,
): Array<string> {
  const rs = getRoomRunnerState(roomId)
  const now = Date.now()
  const expired: Array<string> = []
  for (const [key, turn] of rs.inFlight.entries()) {
    if (turn.lease?.owner === leaseOwner) stateStore?.renew(turn.lease, 30_000)
    if (!turn.recovered && now - turn.startedAt > hardCapMs) {
      rs.inFlight.delete(key)
      if (turn.lease) stateStore?.release(turn.lease)
      expired.push(key)
    }
  }
  if (expired.length) persistRoom(roomId)
  return expired
}

/** Test helper: wipe all runner state. */
export function clearAllRunnerState(): void {
  getState().clear()
  stateStore = null
}
