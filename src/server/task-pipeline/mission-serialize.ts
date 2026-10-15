/**
 * Shared Mission list/detail serialization for /api/tasks and /api/missions.
 */
import type {
  SwarmMission,
  SwarmMissionAssignment,
} from '../swarm-missions'
import {
  deriveMissionStatus,
  effectiveMissionStatus,
  type MissionStatus,
} from '../task-pipeline/mission-status'

export function serializeMissionTask(assignment: SwarmMissionAssignment) {
  return {
    id: assignment.id,
    workerId: assignment.workerId,
    task: assignment.task,
    rationale: assignment.rationale,
    state: assignment.state,
    stageKey: assignment.stageKey ?? null,
    dependsOn: assignment.dependsOn,
    createdByWorkerId: assignment.createdByWorkerId ?? null,
    dispatchable: assignment.dispatchable !== false,
    externalRef: assignment.externalRef ?? null,
    workspacePath: assignment.workspacePath ?? null,
    dispatchedAt: assignment.dispatchedAt,
    completedAt: assignment.completedAt,
  }
}

export type MissionSummary = {
  title: string
  /** Effective status (board pin ?? derived) — Multica-style single field. */
  status: MissionStatus
  /** @deprecated Prefer `status` */
  lane: MissionStatus
  missionId: string | null
  /** @deprecated Prefer `status` */
  missionState: MissionStatus | null
  /** Derived from tasks only (ignores board pin). */
  derivedStatus: MissionStatus | null
  /** @deprecated Prefer `derivedStatus` */
  derivedLane: MissionStatus | null
  currentAssignee: string | null
  /** Active pipeline stage key for the in-flight task; null when unset (e.g. Swarm2). */
  currentStage: string | null
  executionMode: string | null
  assignee: SwarmMission['assignee']
  roomId: string | null
  pipelineId: string | null
  projectId: string | null
  priority: number | null
  labels: Array<string>
  taskCount: number
  /** Human board pin when set. */
  boardLane: MissionStatus | null
}

function pickActiveAssignment(mission: SwarmMission | null) {
  if (!mission) return null
  return (
    mission.assignments.find(
      (a) =>
        a.state === 'dispatched' ||
        a.state === 'blocked' ||
        a.state === 'needs_input' ||
        a.state === 'reviewing',
    ) ??
    mission.assignments.find((a) => a.state === 'queued') ??
    null
  )
}

export function buildMissionSummary(input: {
  cardTitle?: string
  cardStatus?: string
  mission: SwarmMission | null
}): MissionSummary {
  const { mission } = input
  if (!mission) {
    const fallback = (input.cardStatus as MissionStatus | undefined) ?? 'todo'
    return {
      title: input.cardTitle ?? 'Untitled',
      status: fallback,
      lane: fallback,
      missionId: null,
      missionState: null,
      derivedStatus: null,
      derivedLane: null,
      currentAssignee: null,
      currentStage: null,
      executionMode: null,
      assignee: null,
      roomId: null,
      pipelineId: null,
      projectId: null,
      priority: null,
      labels: [],
      taskCount: 0,
      boardLane: null,
    }
  }
  const derived = deriveMissionStatus(mission.assignments)
  const status = effectiveMissionStatus({
    state: mission.state,
    boardLane: mission.boardLane,
    assignments: mission.assignments,
  })
  const active = pickActiveAssignment(mission)
  return {
    title: mission.title?.trim()
      ? mission.title.trim()
      : (input.cardTitle ?? 'Untitled'),
    status,
    lane: status,
    missionId: mission.id,
    missionState: mission.state,
    derivedStatus: derived,
    derivedLane: derived,
    currentAssignee:
      active?.workerId ??
      (mission.assignee?.type === 'agent' ? mission.assignee.id : null),
    currentStage: active?.stageKey ?? null,
    executionMode: mission.executionMode ?? null,
    assignee: mission.assignee ?? null,
    roomId: mission.roomId ?? null,
    pipelineId: mission.pipelineId ?? null,
    projectId: mission.projectId ?? null,
    priority: mission.priority ?? null,
    labels: mission.labels ?? [],
    taskCount: mission.assignments.length,
    boardLane: mission.boardLane ?? null,
  }
}

export function buildTaskRuntimeSnapshot(input: {
  mission: SwarmMission
  assignment: SwarmMissionAssignment
}) {
  const { mission, assignment } = input
  return {
    task_id: assignment.id,
    mission_id: mission.id,
    status: assignment.state,
    external_ref: assignment.externalRef ?? null,
    dispatchable: assignment.dispatchable !== false,
    workspace: { path: assignment.workspacePath ?? null },
    worker_id: assignment.workerId,
    created_by: assignment.createdByWorkerId ?? null,
    stage_key: assignment.stageKey ?? null,
    running:
      assignment.state === 'dispatched'
        ? {
            started_at: assignment.dispatchedAt,
            worker_id: assignment.workerId,
          }
        : null,
    retry: null,
  }
}
