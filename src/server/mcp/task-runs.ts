import { ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import { getSwarmMission } from '../swarm-missions'
import { existsSync } from 'node:fs'
import type { SwarmMissionAssignment } from '../swarm-missions'
import {
  TASK_RUN_STATUSES,
  type TaskRunStatus,
  isTaskRunStatus,
} from '../schema'

export type { TaskRunStatus }
export { TASK_RUN_STATUSES, isTaskRunStatus }

export type TaskRun = {
  id: string
  taskId: string
  missionId: string
  assignmentId: string
  roomId: string | null
  agentId: string
  runtime: string
  status: TaskRunStatus
  startedAt: number
  endedAt: number | null
  summary: string | null
  blocker: string | null
  nextAction: string | null
  logPath: string | null
  checkpointJson: string | null
  projectId: string | null
  branch: string | null
  baseRef: string | null
  headSha: string | null
  worktreePath: string | null
  filesChanged: string | null
}

function now(): number {
  return Date.now()
}

/**
 * Start a task run. The runId is supplied by the dispatcher (token issuer) —
 * token granularity = one run, so the token's runId and the task_runs.id MUST
 * be the same value (plan: "幂等键是 (assignmentId, attempt)，即 runId").
 * Inserting with a caller-supplied id also gives us idempotency for free:
 * a duplicate task_start for the same run hits the PRIMARY KEY conflict.
 */
export function startTaskRun(input: {
  runId: string
  taskId: string
  missionId: string
  assignmentId: string
  agentId: string
  runtime: string
  roomId?: string | null
  projectId?: string | null
  branch?: string | null
  baseRef?: string | null
  worktreePath?: string | null
  dbPath?: string
}): TaskRun {
  const dbPath = input.dbPath ?? getCollabDbPath()
  ensureCollabDb(dbPath)
  const id = input.runId
  const startedAt = now()
  const db = openSqliteDatabase(dbPath, false)
  try {
    db.prepare(
      `
      INSERT INTO task_runs
      (id, task_id, mission_id, assignment_id, room_id, agent_id, runtime, status, started_at, ended_at,
       summary, blocker, next_action, log_path, checkpoint_json, project_id, branch, base_ref, head_sha, worktree_path, files_changed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, NULL)
    `,
    ).run(
      id,
      input.taskId,
      input.missionId,
      input.assignmentId,
      input.roomId ?? null,
      input.agentId,
      input.runtime,
      'running',
      startedAt,
      input.projectId ?? null,
      input.branch ?? null,
      input.baseRef ?? null,
      input.worktreePath ?? null,
    )
  } finally {
    db.close()
  }
  return {
    id,
    taskId: input.taskId,
    missionId: input.missionId,
    assignmentId: input.assignmentId,
    roomId: input.roomId ?? null,
    agentId: input.agentId,
    runtime: input.runtime,
    status: 'running',
    startedAt,
    endedAt: null,
    summary: null,
    blocker: null,
    nextAction: null,
    logPath: null,
    checkpointJson: null,
    projectId: input.projectId ?? null,
    branch: input.branch ?? null,
    baseRef: input.baseRef ?? null,
    headSha: null,
    worktreePath: input.worktreePath ?? null,
    filesChanged: null,
  }
}

/**
 * Complete a run. Ownership predicates (assignment_id, agent_id) are folded
 * into the UPDATE's WHERE clause so the check-and-write is a single atomic
 * statement — no TOCTOU between a prior SELECT and this UPDATE.
 * Returns true iff a row was actually transitioned out of 'running'.
 */
export function completeTaskRun(input: {
  runId: string
  status: TaskRunStatus
  assignmentId?: string
  agentId?: string
  summary?: string | null
  blocker?: string | null
  nextAction?: string | null
  logPath?: string | null
  checkpointJson?: string | null
  headSha?: string | null
  filesChanged?: string | null
  dbPath?: string
}): boolean {
  if (!isTaskRunStatus(input.status)) {
    throw new Error(`Invalid TaskRunStatus: ${input.status}`)
  }
  const dbPath = input.dbPath ?? getCollabDbPath()
  const db = openSqliteDatabase(dbPath, false)
  try {
    const result = db
      .prepare(
        `
      UPDATE task_runs
      SET status = ?, ended_at = ?, summary = ?, blocker = ?, next_action = ?, log_path = ?, checkpoint_json = ?, head_sha = ?, files_changed = ?
      WHERE id = ? AND status = 'running'
        AND (? IS NULL OR assignment_id = ?)
        AND (? IS NULL OR agent_id = ?)
    `,
      )
      .run(
        input.status,
        now(),
        input.summary ?? null,
        input.blocker ?? null,
        input.nextAction ?? null,
        input.logPath ?? null,
        input.checkpointJson ?? null,
        input.headSha ?? null,
        input.filesChanged ?? null,
        input.runId,
        input.assignmentId ?? null,
        input.assignmentId ?? null,
        input.agentId ?? null,
        input.agentId ?? null,
      )
    return result.changes > 0
  } finally {
    db.close()
  }
}

export function getTaskRun(runId: string, dbPath?: string): TaskRun | null {
  const path = dbPath ?? getCollabDbPath()
  const db = openSqliteDatabase(path, true)
  try {
    const rows = db.prepare('SELECT * FROM task_runs WHERE id = ?').all(runId)
    if (rows.length === 0) return null
    const row = rows[0]
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      missionId: String(row.mission_id),
      assignmentId: String(row.assignment_id),
      roomId: row.room_id ? String(row.room_id) : null,
      agentId: String(row.agent_id),
      runtime: String(row.runtime),
      status: row.status as TaskRunStatus,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : null,
      summary: row.summary ? String(row.summary) : null,
      blocker: row.blocker ? String(row.blocker) : null,
      nextAction: row.next_action ? String(row.next_action) : null,
      logPath: row.log_path ? String(row.log_path) : null,
      checkpointJson: row.checkpoint_json ? String(row.checkpoint_json) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      branch: row.branch ? String(row.branch) : null,
      baseRef: row.base_ref ? String(row.base_ref) : null,
      headSha: row.head_sha ? String(row.head_sha) : null,
      worktreePath: row.worktree_path ? String(row.worktree_path) : null,
      filesChanged: row.files_changed ? String(row.files_changed) : null,
    }
  } finally {
    db.close()
  }
}

export function countRunningRunsForAgent(
  agentId: string,
  dbPath?: string,
): number {
  const path = dbPath ?? getCollabDbPath()
  if (!existsSync(path)) return 0
  const db = openSqliteDatabase(path, true)
  try {
    const rows = db
      .prepare(
        "SELECT COUNT(*) as count FROM task_runs WHERE agent_id = ? AND status = 'running'",
      )
      .all(agentId)
    if (rows.length === 0) return 0
    return Number(rows[0].count)
  } finally {
    db.close()
  }
}

export function getTaskForAgent(input: {
  missionId: string
  assignmentId: string
  agentId: string
}): { task: SwarmMissionAssignment; missionTitle: string } | null {
  const mission = getSwarmMission(input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find(
    (item) => item.id === input.assignmentId,
  )
  if (!assignment) return null
  if (assignment.workerId !== input.agentId) return null
  return { task: assignment, missionTitle: mission.title }
}
