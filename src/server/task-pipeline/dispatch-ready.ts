/**
 * dispatch-ready — shared kickoff for Mission Control pipeline missions.
 *
 * Routes ready queued assignments by runtime:
 *   - hermes  → existing swarm-dispatch path (dispatchSwarmAssignments, async)
 *   - managed → agent-runtime dispatchAssignment
 *
 * Used by:
 *   - createTask autoDispatch kickoff
 *   - POST /api/missions/:missionId/start retry/continue
 *   - terminal checkpoint continuation hook
 */
import { dispatchSwarmAssignments } from '../swarm-dispatch-service'
import { dispatchAssignment } from '../agent-runtime/dispatch'
import { installAdvanceBridge } from '../agent-runtime/advance'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  getSwarmMission,
  readyQueuedAssignments,
  recordMissionAssignmentBlocked,
  setOnCheckpointTerminalHook,
} from '../swarm-missions'
// Side-effect: register the swarm-path review verdict hook. review.ts is not
// naturally imported by the hermes/swarm checkpoint path; pulling it in here
// (dispatch-ready is imported by swarm-dispatch/task-service) wires it up.
import {
  claimTask,
  markTaskStarted,
  releaseTaskClaim,
  scheduleTaskRetry,
} from './task-scheduler'
import type { TaskDispatchClaim } from './task-scheduler'

// Production Mission MCP → assignment advance: task_complete drives the next
// ready stage. Idempotent; tests may reinstall with custom dispatchNext.
installAdvanceBridge({
  dispatchNext: async ({ missionId, assignmentId }) => {
    await dispatchReadyAssignments(missionId, { assignmentId })
  },
})

export type DispatchedAssignmentSummary = {
  assignmentId: string
  workerId: string
  ok: boolean
  error?: string
  needsHuman?: boolean
}

export type DispatchReadyResult = {
  ok: boolean
  dispatched: Array<DispatchedAssignmentSummary>
}

function resolveAssignmentRuntime(workerId: string): 'hermes' | 'managed' {
  try {
    const decl = getAgentRuntimeRouter().registry.byId.get(workerId)
    if (decl) return decl.runtime === 'hermes' ? 'hermes' : 'managed'
  } catch (error) {
    console.warn(
      `[dispatch-ready] failed to resolve runtime for ${workerId}:`,
      error instanceof Error ? error.message : String(error),
    )
  }
  return 'hermes'
}

async function syncCardLane(_missionId: string): Promise<void> {
  // Mission board lanes are derived from assignment state; no kanban card sync.
}

/**
 * Dispatch all ready queued assignments for a mission.
 * Partial failures do not roll back already-dispatched assignments.
 */
export async function dispatchReadyAssignments(
  missionId: string,
  options?: { assignmentId?: string },
): Promise<DispatchReadyResult> {
  const claims = new Map<string, TaskDispatchClaim>()
  const ready = readyQueuedAssignments(missionId).filter((assignment) => {
    if (options?.assignmentId && assignment.id !== options.assignmentId)
      return false
    const claim = claimTask({ missionId, assignmentId: assignment.id })
    if (!claim) return false
    claims.set(assignment.id, claim)
    return true
  })
  if (ready.length === 0) {
    return { ok: true, dispatched: [] }
  }

  const hermesAssignments = ready.filter(
    (a) => resolveAssignmentRuntime(a.workerId) === 'hermes',
  )
  const managedAssignments = ready.filter(
    (a) => resolveAssignmentRuntime(a.workerId) === 'managed',
  )

  const dispatched: Array<DispatchedAssignmentSummary> = []

  if (hermesAssignments.length > 0) {
    try {
      const result = await dispatchSwarmAssignments(
        {
          missionId,
          assignments: hermesAssignments.map((a) => ({
            workerId: a.workerId,
            task: a.task,
            rationale: a.rationale ?? undefined,
            dependsOn: a.dependsOn,
            reviewRequired: a.reviewRequired,
            assignmentId: a.id,
            direct: false,
          })),
          allowAsync: true,
        },
        claims,
      )
      for (const [index, assignment] of hermesAssignments.entries()) {
        const workerResult = result.results[index] ?? {
          ok: false,
          error: 'missing result',
        }
        dispatched.push({
          assignmentId: assignment.id,
          workerId: assignment.workerId,
          ok: workerResult.ok,
          error: workerResult.error ?? undefined,
        })
      }
    } catch (error) {
      for (const assignment of hermesAssignments) {
        dispatched.push({
          assignmentId: assignment.id,
          workerId: assignment.workerId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  for (const assignment of managedAssignments) {
    try {
      const result = await dispatchAssignment({
        missionId,
        assignmentId: assignment.id,
        schedulerClaim: claims.get(assignment.id),
      })
      dispatched.push({
        assignmentId: assignment.id,
        workerId: assignment.workerId,
        ok: result.ok,
        error: result.ok ? undefined : (result as { error: string }).error,
        needsHuman: !result.ok && result.needsHuman === true,
      })
    } catch (error) {
      dispatched.push({
        assignmentId: assignment.id,
        workerId: assignment.workerId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await syncCardLane(missionId)

  for (const row of dispatched) {
    if (row.ok) {
      markTaskStarted(row.assignmentId)
    } else {
      releaseTaskClaim(row.assignmentId)
      const assignment = getSwarmMission(missionId)?.assignments.find(
        (item) => item.id === row.assignmentId,
      )
      if (assignment?.state === 'queued' && !row.needsHuman) {
        scheduleTaskRetry({
          missionId,
          assignmentId: row.assignmentId,
          kind: 'failure',
          error: row.error,
        })
      } else if (
        assignment &&
        !['done', 'cancelled', 'checkpointed'].includes(assignment.state)
      ) {
        recordMissionAssignmentBlocked({
          missionId,
          assignmentId: row.assignmentId,
          workerId: row.workerId,
          reason: row.error ?? 'Dispatch failed',
          source: 'task-scheduler',
        })
      }
    }
  }

  return {
    ok: dispatched.every((d) => d.ok),
    dispatched,
  }
}

/**
 * Terminal checkpoint continuation: when a pipeline mission worker reports
 * DONE/HANDOFF, try to dispatch the next ready stage. Fire-and-forget so
 * harvest/mission-sync callers are not blocked.
 *
 * An in-flight Set prevents duplicate concurrent continuations for the same
 * mission. MCP callers skip this path — advance.ts already dispatches next.
 */
const continuationInFlight = new Set<string>()

setOnCheckpointTerminalHook(({ missionId, checkpoint, source }) => {
  if (source === 'mcp') return
  if (checkpoint.stateLabel !== 'DONE' && checkpoint.stateLabel !== 'HANDOFF') {
    return
  }
  const mission = getSwarmMission(missionId)
  if (!mission?.pipelineId) return
  if (continuationInFlight.has(missionId)) return

  continuationInFlight.add(missionId)
  void (async () => {
    try {
      await dispatchReadyAssignments(missionId)
    } catch (error) {
      console.error(
        `[dispatch-ready] checkpoint continuation failed for ${missionId}:`,
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      continuationInFlight.delete(missionId)
    }
  })()
})
