/**
 * Centralized Agorax domain enums and status constants.
 *
 * This module is the single source of truth for status values that were
 * previously duplicated across `swarm-missions.ts`, `mcp/task-runs.ts`, and
 * `task-pipeline/mission-status.ts`.
 */

// ── Swarm mission assignment states ──────────────────────────────────────

export const SWARM_MISSION_ASSIGNMENT_STATES = [
  'queued',
  'dispatched',
  'checkpointed',
  'blocked',
  'needs_input',
  'reviewing',
  'done',
  'cancelled',
] as const

export type SwarmMissionAssignmentState =
  (typeof SWARM_MISSION_ASSIGNMENT_STATES)[number]

export function isSwarmMissionAssignmentState(
  value: unknown,
): value is SwarmMissionAssignmentState {
  return (
    typeof value === 'string' &&
    (SWARM_MISSION_ASSIGNMENT_STATES as readonly string[]).includes(value)
  )
}

// ── Task run statuses ────────────────────────────────────────────────────

export const TASK_RUN_STATUSES = [
  'running',
  'done',
  'blocked',
  'needs_input',
  'failed',
  'cancelled',
] as const

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number]

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return (
    typeof value === 'string' &&
    (TASK_RUN_STATUSES as readonly string[]).includes(value)
  )
}

// ── Mission / board statuses ─────────────────────────────────────────────

export const MISSION_STATUSES = [
  'todo',
  'ready',
  'running',
  'review',
  'blocked',
  'done',
  'cancelled',
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export function isMissionStatus(value: unknown): value is MissionStatus {
  return (
    typeof value === 'string' &&
    (MISSION_STATUSES as readonly string[]).includes(value)
  )
}

// ── Mapping: assignment state -> task run status ─────────────────────────

/**
 * Terminal assignment states that no longer represent active dispatch work.
 */
export const TERMINAL_ASSIGNMENT_STATES: ReadonlyArray<
  SwarmMissionAssignmentState
> = [
  'done',
  'cancelled',
  // checkpointed/blocked/needs_input are terminal for dispatch purposes: a worker
  // may receive a new assignment on re-dispatch without inheriting stale checkpoints.
  'checkpointed',
  'blocked',
  'needs_input',
]

/**
 * Map an assignment terminal state to the canonical task_run status used when
 * the run completes. `dispatched` and `reviewing` are not mapped here because
 * they remain active run states.
 */
export const ASSIGNMENT_TO_TASK_RUN_STATUS: Record<
  Exclude<
    SwarmMissionAssignmentState,
    'queued' | 'dispatched' | 'reviewing'
  >,
  TaskRunStatus
> = {
  checkpointed: 'done',
  blocked: 'blocked',
  needs_input: 'needs_input',
  done: 'done',
  cancelled: 'cancelled',
}
