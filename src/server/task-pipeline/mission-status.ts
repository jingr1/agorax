/**
 * Mission status — Multica-style single vocabulary.
 *
 * Board columns, list sections, and `mission.state` all use the same enum.
 * Optional `boardLane` is only a human pin; effective status = boardLane ?? state.
 */
import type { SwarmMissionAssignment } from '../swarm-missions'
import {
  MISSION_STATUSES,
  type MissionStatus,
  isMissionStatus,
} from '../schema'

export type { MissionStatus }
export { MISSION_STATUSES, isMissionStatus }

/** @deprecated Use MissionStatus — same set (Multica: column = status). */
export type KanbanLane = MissionStatus

const LEGACY_STATUS_MAP: Record<string, MissionStatus> = {
  planning: 'todo',
  dispatching: 'ready',
  executing: 'running',
  reviewing: 'review',
  complete: 'done',
  completed: 'done',
  backlog: 'todo',
  todo: 'todo',
  ready: 'ready',
  running: 'running',
  review: 'review',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
}

/** Normalize persisted / API / legacy swarm states into MissionStatus. */
export function normalizeMissionStatus(value: unknown): MissionStatus {
  if (typeof value !== 'string') return 'todo'
  const key = value.trim().toLowerCase()
  return LEGACY_STATUS_MAP[key] ?? 'todo'
}

/**
 * Derive mission status from assignment states (source of truth when no pin).
 */
export function deriveMissionStatus(
  assignments: Array<SwarmMissionAssignment>,
): MissionStatus {
  if (
    assignments.length > 0 &&
    assignments.every((item) => item.state === 'cancelled')
  ) {
    return 'cancelled'
  }
  if (
    assignments.some(
      (item) => item.state === 'blocked' || item.state === 'needs_input',
    )
  ) {
    return 'blocked'
  }
  if (
    assignments.length > 0 &&
    assignments.every(
      (item) =>
        item.state === 'done' ||
        item.state === 'cancelled' ||
        (item.state === 'checkpointed' && !item.reviewRequired),
    )
  ) {
    return 'done'
  }
  if (
    assignments.some(
      (item) =>
        item.state === 'reviewing' ||
        (item.state === 'checkpointed' && item.reviewRequired),
    )
  ) {
    return 'review'
  }
  if (assignments.some((item) => item.state === 'dispatched')) {
    return 'running'
  }
  if (assignments.some((item) => item.state === 'checkpointed')) {
    return 'review'
  }
  if (assignments.some((item) => item.state === 'queued')) {
    return 'ready'
  }
  return 'todo'
}

export function effectiveMissionStatus(input: {
  state?: unknown
  boardLane?: unknown
  assignments?: Array<SwarmMissionAssignment>
}): MissionStatus {
  if (input.boardLane != null && String(input.boardLane).trim() !== '') {
    return normalizeMissionStatus(input.boardLane)
  }
  if (input.assignments) {
    return deriveMissionStatus(input.assignments)
  }
  return normalizeMissionStatus(input.state)
}
