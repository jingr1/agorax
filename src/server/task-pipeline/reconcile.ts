/**
 * reconcile — P2a boot reconciliation (plan «dual-storage & crash recovery»).
 *
 * Runs BEFORE the server listens. Reads mission / assignment state from the
 * MissionRepository abstraction (SQLite source of truth when
 * AGORAX_MISSION_SQLITE_SOT=1; otherwise the JSON-backed repository). The
 * legacy direct JSON read has been removed; this module only talks to the
 * repository facade.
 *
 * Repairs the split-brain window between the mission repository and
 * collab.db task_runs (run source of truth). They are not transactional with
 * each other; this pass makes the known liability RECOVERABLE.
 *
 * Disposition table (plan, verbatim):
 *
 * | finding                                                        | action |
 * |----------------------------------------------------------------|--------|
 * | task_runs running & assignment still queued                    | run → failed(crash_orphan); BLOCK CAS re-dispatch of the assignment; kill pid group; open pending_turns |
 * | assignment dispatched & NO task_runs row                       | requeue assignment → queued, event dispatch_incomplete (safe direction — never spawned) |
 * | running row + assignment dispatched + pid group dead           | run → failed; assignment → blocked + pending_turns; NO auto re-dispatch (unknown half-done worktree) |
 * | running row + process still alive                              | re-attach only; no state change |
 *
 * Manual re-dispatch shares the rule with active reassignment: revoke the
 * old run's tokens first, then CAS the new attempt.
 */
import { existsSync } from 'node:fs'
import { createCollabId, getCollabDbPath, insertCollabRow } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import { completeTaskRun } from '../mcp/task-runs'
import { revokeRunTokensForRun } from '../mcp/run-tokens'
import { publishChatEvent } from '../chat-event-bus'
import {
  isProcessGroupAlive,
  killProcessGroup,
  listPids,
  unregisterPid,
} from '../agent-runtime/pid-registry'
import {
  listSwarmMissions,
  recordMissionAssignmentBlocked,
  requeueMissionAssignment,
} from '../swarm-missions'

export type ReconcileFinding =
  | {
      kind: 'crash_orphan'
      runId: string
      missionId: string
      assignmentId: string
    }
  | { kind: 'dispatch_incomplete'; missionId: string; assignmentId: string }
  | {
      kind: 'process_dead'
      runId: string
      missionId: string
      assignmentId: string
      pid: number
    }
  | { kind: 'reattached'; runId: string; pid: number }

export type ReconcileReport = {
  findings: Array<ReconcileFinding>
  runningRunsSeen: number
  dispatchedAssignmentsSeen: number
}

type RunningRow = {
  id: string
  mission_id: string
  assignment_id: string
  agent_id: string
  room_id: string | null
}

function listRunningRuns(dbPath: string): Array<RunningRow> {
  if (!existsSync(dbPath)) return [] // no collab.db yet → nothing running
  const db = openSqliteDatabase(dbPath, true)
  try {
    return db
      .prepare(
        "SELECT id, mission_id, assignment_id, agent_id, room_id FROM task_runs WHERE status = 'running'",
      )
      .all() as unknown as Array<RunningRow>
  } finally {
    db.close()
  }
}

function openPendingTurn(input: {
  roomId: string | null
  taskId: string
  assignmentId: string
  targetParticipantId: string
  kind: string
  reason: string
  dbPath: string
}): void {
  const id = createCollabId('pt')
  insertCollabRow(
    'pending_turns',
    {
      id,
      room_id: input.roomId,
      task_id: input.taskId,
      assignment_id: input.assignmentId,
      requested_by: 'reconcile',
      target_participant_id: input.targetParticipantId,
      kind: input.kind,
      reason: input.reason,
      status: 'pending',
      created_at: Date.now(),
    },
    input.dbPath,
  )
  publishChatEvent('group_chat_human_attention', {
    scope: 'global',
    roomId: input.roomId,
    pendingTurnId: id,
    kind: input.kind,
    reason: input.reason,
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    missionId: input.taskId,
  })
}

export function reconcileOnBoot(input?: { dbPath?: string }): ReconcileReport {
  const dbPath = input?.dbPath ?? getCollabDbPath()
  const findings: Array<ReconcileFinding> = []
  const runningRuns = listRunningRuns(dbPath)
  const pidEntries = new Map(listPids().map((e) => [e.runId, e]))

  const missions = listSwarmMissions(500)
  const assignmentIndex = new Map<
    string,
    { missionId: string; state: string }
  >()
  for (const mission of missions) {
    for (const a of mission.assignments) {
      assignmentIndex.set(a.id, { missionId: mission.id, state: a.state })
    }
  }

  // ── Pass 1: every running task_runs row ──────────────────────────────
  for (const run of runningRuns) {
    const asg = assignmentIndex.get(run.assignment_id)
    const pidEntry = pidEntries.get(run.id)
    const alive = pidEntry ? isProcessGroupAlive(pidEntry.pid) : false

    if (asg && asg.state === 'queued') {
      // crash_orphan: run row exists but the pipeline never dispatched.
      completeTaskRun({
        runId: run.id,
        status: 'failed',
        summary: 'crash_orphan: running row with queued assignment',
        dbPath,
      })
      revokeRunTokensForRun(run.id, dbPath)
      if (pidEntry && alive) killProcessGroup(pidEntry.pid, 'SIGKILL')
      if (pidEntry) unregisterPid(run.id)
      openPendingTurn({
        roomId: run.room_id,
        taskId: run.mission_id,
        assignmentId: run.assignment_id,
        targetParticipantId: run.agent_id,
        kind: 'blocked',
        reason:
          'crash_orphan: run row present but assignment never dispatched; manual review required before re-dispatch',
        dbPath,
      })
      findings.push({
        kind: 'crash_orphan',
        runId: run.id,
        missionId: run.mission_id,
        assignmentId: run.assignment_id,
      })
      continue
    }

    if (asg && asg.state === 'dispatched') {
      if (alive) {
        // Process still alive: re-attach only (PTY re-attach is a UI concern;
        // the pid registry entry is already correct).
        findings.push({ kind: 'reattached', runId: run.id, pid: pidEntry!.pid })
      } else {
        // Process dead: fail the run, block the assignment, human decides.
        completeTaskRun({
          runId: run.id,
          status: 'failed',
          summary: 'process group dead at boot',
          dbPath,
        })
        revokeRunTokensForRun(run.id, dbPath)
        if (pidEntry) unregisterPid(run.id)
        recordMissionAssignmentBlocked({
          missionId: run.mission_id,
          assignmentId: run.assignment_id,
          workerId: run.agent_id,
          reason:
            'process died while server was down; not auto re-dispatched (unknown half-done worktree state)',
          source: 'reconcile',
        })
        openPendingTurn({
          roomId: run.room_id,
          taskId: run.mission_id,
          assignmentId: run.assignment_id,
          targetParticipantId: run.agent_id,
          kind: 'blocked',
          reason:
            'process_dead at boot; assignment blocked pending human decision',
          dbPath,
        })
        findings.push({
          kind: 'process_dead',
          runId: run.id,
          missionId: run.mission_id,
          assignmentId: run.assignment_id,
          pid: pidEntry?.pid ?? -1,
        })
      }
      continue
    }
    // running row whose assignment is terminal/unknown: fail the run quietly.
    completeTaskRun({
      runId: run.id,
      status: 'failed',
      summary: 'orphaned running row (assignment terminal or unknown)',
      dbPath,
    })
    revokeRunTokensForRun(run.id, dbPath)
    if (pidEntry && alive) killProcessGroup(pidEntry.pid, 'SIGKILL')
    if (pidEntry) unregisterPid(run.id)
  }

  // ── Pass 2: dispatched assignments with no run row (never spawned) ───
  let dispatchedSeen = 0
  const runningAssignmentIds = new Set(runningRuns.map((r) => r.assignment_id))
  for (const mission of missions) {
    for (const a of mission.assignments) {
      if (a.state !== 'dispatched') continue
      dispatchedSeen++
      if (runningAssignmentIds.has(a.id)) continue // handled in pass 1
      // Safe direction: requeue so the next advance cycle can dispatch it.
      requeueMissionAssignment({
        missionId: mission.id,
        assignmentId: a.id,
        reason:
          'dispatch_incomplete: assignment dispatched but no task_runs row (server crashed before spawn)',
      })
      findings.push({
        kind: 'dispatch_incomplete',
        missionId: mission.id,
        assignmentId: a.id,
      })
    }
  }

  const report: ReconcileReport = {
    findings,
    runningRunsSeen: runningRuns.length,
    dispatchedAssignmentsSeen: dispatchedSeen,
  }
  if (findings.length > 0) {
    publishChatEvent('reconcile_completed', {
      findings: findings.length,
      kinds: findings.map((f) => f.kind),
    })
    console.warn('[reconcile] boot repairs:', JSON.stringify(report))
  }
  return report
}
