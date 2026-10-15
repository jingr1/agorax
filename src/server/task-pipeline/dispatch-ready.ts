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
import { dispatchSwarmAssignments } from '../../routes/api/swarm-dispatch'
import { dispatchAssignment } from '../agent-runtime/dispatch'
import { installAdvanceBridge } from '../agent-runtime/advance'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import {
  getSwarmMission,
  readyQueuedAssignments,
  setOnCheckpointTerminalHook,
} from '../swarm-missions'
// Side-effect: register the swarm-path review verdict hook. review.ts is not
// naturally imported by the hermes/swarm checkpoint path; pulling it in here
// (dispatch-ready is imported by swarm-dispatch/task-service) wires it up.
import { markTaskRunning, releaseTaskClaim } from './task-scheduler'

// Production Mission MCP → assignment advance: task_complete drives the next
// ready stage. Idempotent; tests may reinstall with custom dispatchNext.
installAdvanceBridge({
  dispatchNext: async ({ missionId, assignmentId }) => {
    await dispatchAssignment({ missionId, assignmentId })
  },
})

export type DispatchedAssignmentSummary = {
  assignmentId: string
  workerId: string
  ok: boolean
  error?: string
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
): Promise<DispatchReadyResult> {
  const ready = readyQueuedAssignments(missionId)
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
      const result = await dispatchSwarmAssignments({
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
      })
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
      })
      dispatched.push({
        assignmentId: assignment.id,
        workerId: assignment.workerId,
        ok: result.ok,
        error: result.ok ? undefined : (result as { error: string }).error,
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
      markTaskRunning({ missionId, assignmentId: row.assignmentId })
    } else {
      releaseTaskClaim(row.assignmentId)
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
