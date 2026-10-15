/**
 * advance — P1 步骤 3 的状态推进汇合点（plan 模块 1 «advance.ts：本计划的
 * 核心新代码»，最小形态）.
 *
 * Wires the MCP control channel into the mission state machine:
 *   task_complete (run terminal) → assignment state → dispatch next ready
 *   stage (dependsOn satisfied).
 *
 * CONVERGENCE / SERIALIZATION REQUIREMENT (architect note, P1.4 review):
 * this module is THE single rendezvous point where both report channels
 * must enter readyQueuedAssignments:
 *   - MCP path:    task_complete → onRunTerminal hook → handleRunTerminal
 *   - hermes path: stdout text → parseSwarmCheckpoint → STATE=DONE
 *                  (currently recorded via recordMissionCheckpoint from the
 *                  swarm harvester, NOT yet routed through here)
 *
 * SERIALIZATION DECISION (P2a gate, architect hard requirement):
 * the advance critical section is serialized by an IN-MEMORY MUTEX
 * (promise-chain queue, `advanceQueue` below), not a db transaction.
 * Rationale: the mission store — the state machine we must not corrupt —
 * lives in swarm-missions.json (read-modify-write JSON + atomic rename),
 * NOT in SQLite, so a SQLite transaction cannot guard it. collab.db only
 * holds run/token rows. A db transaction would give the illusion of safety
 * while the JSON CAS still races. The mutex covers the whole
 * "read mission → record terminal → compute readyQueuedAssignments →
 * dispatch next" sequence so two concurrent terminal events (one MCP, one
 * hermes) can never observe the same pre-write snapshot.
 * Limit: single-process. The workspace server is single-process by design
 * (plan: 单 workspace server 进程承载 N 个托管 agent), so an in-memory
 * mutex is sufficient; multi-process would need a file lock — out of scope.
 *
 * Load-test note (P1.4 review): the 8-agent streaming soak is deferred to
 * UI integration (bottleneck is SSE fan-out / event loop, not the MCP
 * control plane). When it runs, it MUST assert «text_delta 永不落库»
 * (review item 6) — display-channel events are bus-only; collab.db must
 * show zero growth from streaming.
 *
 * Full pipeline-template features (review stages, rework loops, lane sync,
 * git mergeSiblings) belong to 模块 1 and are NOT in this file — this is the
 * minimal end-to-end spine validated in P1 步骤 3.
 */
import * as path from 'node:path'
import {
  getSwarmMission,
  readyQueuedAssignments,
  recordMissionAssignmentBlocked,
  recordMissionCheckpoint,
  setAssignmentBaseRef,
  setAssignmentHeadSha,
} from '../swarm-missions'
import { setOnRunTerminalHook } from '../mcp/mcp-handler'
import { getTaskRun } from '../mcp/task-runs'
import {
  filesChangedBetween,
  localGitContext,
  mergeSiblings,
  pullArtifacts,
  resolveHead,
} from '../git-ops'
import { getProject } from '../task-pipeline/projects'
import { publishChatEvent } from '../chat-event-bus'
import { getAgentRuntimeRouter } from '../agent-runtime/router'
import { applyReviewVerdict } from '../task-pipeline/review'
import { getPipelineTemplate } from '../task-pipeline/pipeline-templates'
import { getProfileSshHost } from './agents-config'
import type { RunTerminalEvent } from '../mcp/mcp-handler'
import {
  postPipelineComplete,
  postStageHandoff,
} from '../group-chat/auto-handoff'
import { openAttentionForMission } from '../group-chat/pending-turn-service'

export type AdvanceHooks = {
  /** Called with each newly-ready assignment after a terminal event. */
  dispatchNext?: (input: {
    missionId: string
    assignmentId: string
  }) => void | Promise<void>
}

let installed = false

/**
 * In-memory mutex: a promise chain serializing every advance critical
 * section (see header «SERIALIZATION DECISION»). Each terminal event is
 * appended; the chain guarantees read→record→ready→dispatch never
 * interleaves with another event's snapshot.
 */
let advanceQueue: Promise<void> = Promise.resolve()

function enqueueAdvance<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = advanceQueue.then(fn)
  // Keep the chain alive even if one section throws.
  advanceQueue = run.then(
    () => undefined,
    (error) => {
      console.error('[advance] critical section failed', error)
    },
  )
  return run
}

async function handleRunTerminal(
  event: RunTerminalEvent,
  hooks?: AdvanceHooks,
): Promise<void> {
  const mission = getSwarmMission(event.missionId)
  if (!mission) return

  const run = getTaskRun(event.runId)
  let headSha: string | null = event.headSha ?? null
  let filesChanged: Array<string> | null = null

  // P2b: capture git state for worktree-mode runs.
  if (run && run.baseRef && run.worktreePath) {
    const project = run.projectId ? getProject(run.projectId) : null
    if (project) {
      try {
        const ctx = localGitContext(project, path.basename(run.worktreePath))
        headSha = await resolveHead(ctx)
        filesChanged = await filesChangedBetween(ctx, run.baseRef, headSha)
      } catch (error) {
        console.error('[advance] failed to read git state', error)
      }
    }
  }

  if (event.status === 'blocked' || event.status === 'needs_input') {
    recordMissionAssignmentBlocked({
      missionId: event.missionId,
      assignmentId: event.assignmentId,
      workerId: event.agentId,
      reason: event.blocker ?? event.summary ?? event.status,
      source: 'mcp',
    })
    try {
      await openAttentionForMission({
        missionId: event.missionId,
        assignmentId: event.assignmentId,
        requestedBy: event.agentId,
        kind: event.status === 'needs_input' ? 'needs_input' : 'blocked',
        reason: event.blocker ?? event.summary ?? event.status,
        nextAction: event.nextAction,
      })
    } catch (error) {
      console.warn(
        '[advance] openAttentionForMission failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  } else if (event.status === 'done') {
    recordMissionCheckpoint({
      missionId: event.missionId,
      assignmentId: event.assignmentId,
      workerId: event.agentId,
      checkpoint: {
        stateLabel: 'DONE',
        checkpointStatus: 'done',
        runtimeState: 'idle',
        filesChanged: filesChanged ? filesChanged.join(', ') : null,
        commandsRun: null,
        result: event.summary,
        blocker: null,
        nextAction: event.nextAction,
        reviewOutcome: null,
        raw: event.summary ?? '',
      },
      source: 'mcp',
    })
  }

  // P2b: stamp git refs onto the assignment for diff API / merge downstream.
  if (run?.baseRef) {
    const assignment = mission.assignments.find(
      (a) => a.id === event.assignmentId,
    )
    if (assignment) {
      // Fan-in convergence may have already set a merged baseRef before
      // dispatching this assignment; do not overwrite it with the stale
      // token-context baseRef.
      if (!assignment.baseRef) {
        setAssignmentBaseRef(mission.id, assignment.id, run.baseRef)
      }
      if (headSha) {
        setAssignmentHeadSha(mission.id, assignment.id, headSha)
      }
    }
  }

  // P2b: pull artifacts from ssh-locality runs back to the local memory tree.
  if (
    mission.workspaceMode === 'worktree' &&
    mission.projectId &&
    event.status !== 'cancelled'
  ) {
    const project = getProject(mission.projectId)
    if (project) {
      const router = getAgentRuntimeRouter()
      const decl = router.registry.byId.get(event.agentId)
      if (decl?.execution === 'ssh') {
        const host =
          (decl.profile ? getProfileSshHost(decl.profile) : null) ??
          project.remotes[0]?.host
        if (host) {
          try {
            await pullArtifacts(project, host, mission.id, event.agentId)
          } catch (error) {
            console.error('[advance] failed to pull artifacts', error)
          }
        }
      }
    }
  }

  // P2a/P2b: review-stage verdict. If the checkpoint text contains
  // REVIEW_OUTCOME, apply the review/rework logic before computing ready
  // assignments so approved releases downstream and changes_requested requeues
  // the build stage.
  if (event.status === 'done') {
    const missionAfterCheckpoint = getSwarmMission(event.missionId) ?? mission
    const assignment = missionAfterCheckpoint.assignments.find(
      (a) => a.id === event.assignmentId,
    )
    const rawCheckpoint = assignment?.checkpoint?.raw ?? event.summary ?? ''
    if (rawCheckpoint.includes('REVIEW_OUTCOME')) {
      const template = missionAfterCheckpoint.pipelineId
        ? getPipelineTemplate(missionAfterCheckpoint.pipelineId)
        : null
      const reviewResult = applyReviewVerdict({
        missionId: event.missionId,
        reviewAssignmentId: event.assignmentId,
        rawCheckpoint,
        reviewerId: event.agentId,
        template: template ?? undefined,
      })
      if (!reviewResult.ok) {
        console.error('[advance] review verdict failed', reviewResult.error)
      } else if (reviewResult.action === 'needs_human') {
        publishChatEvent('assignment_blocked', {
          missionId: event.missionId,
          assignmentId: event.assignmentId,
          reason: reviewResult.reason,
        })
        try {
          await openAttentionForMission({
            missionId: event.missionId,
            assignmentId: event.assignmentId,
            requestedBy: event.agentId,
            kind: 'review',
            reason: reviewResult.reason ?? 'Review gate needs human',
          })
        } catch (error) {
          console.warn(
            '[advance] openAttentionForMission (review) failed',
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }
  }

  // failed/cancelled: leave the assignment dispatched; P2a reconcile
  // decides between requeue and blocked (needs crash forensics).

  publishChatEvent('mission_advanced', {
    missionId: event.missionId,
    assignmentId: event.assignmentId,
    status: event.status,
    roomId: undefined,
  })

  // Dispatch follow-on stages whose dependsOn are now satisfied.
  const ready = readyQueuedAssignments(event.missionId)
  // Re-read the mission after checkpoint/baseRef/headSha updates so fan-in
  // merge sees persisted upstream heads, not the pre-write snapshot.
  const missionAfter = getSwarmMission(event.missionId) ?? mission

  if (event.status === 'done' && ready.length > 0) {
    try {
      const assignment = missionAfter.assignments.find(
        (a) => a.id === event.assignmentId,
      )
      await postStageHandoff({
        missionId: event.missionId,
        fromWorkerId: event.agentId,
        nextAssignments: ready.map((a) => ({
          id: a.id,
          workerId: a.workerId,
        })),
        handoffSummary: {
          result: event.summary ?? assignment?.checkpoint?.result ?? null,
          nextAction:
            event.nextAction ?? assignment?.checkpoint?.nextAction ?? null,
          filesChanged:
            filesChanged?.join(', ') ??
            assignment?.checkpoint?.filesChanged ??
            null,
        },
      })
    } catch (error) {
      console.warn(
        '[advance] postStageHandoff failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  } else if (event.status === 'done' && ready.length === 0) {
    try {
      await postPipelineComplete({
        missionId: event.missionId,
        summary: event.summary,
      })
    } catch (error) {
      console.warn(
        '[advance] postPipelineComplete failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  for (const next of ready) {
    // P2b: fan-in convergence. If the ready assignment has multiple upstream
    // dependencies, merge their head commits into the mission integration
    // branch before dispatching downstream.
    if (
      missionAfter.workspaceMode === 'worktree' &&
      missionAfter.projectId &&
      next.dependsOn.length > 1
    ) {
      const project = getProject(missionAfter.projectId)
      if (project) {
        const upstreamHeads = next.dependsOn
          .map(
            (depId) =>
              missionAfter.assignments.find((a) => a.id === depId)?.headSha,
          )
          .filter((sha): sha is string => Boolean(sha))
        if (upstreamHeads.length > 1) {
          try {
            const mergeResult = await mergeSiblings(
              project,
              mission.id,
              upstreamHeads,
            )
            if (!mergeResult.ok) {
              recordMissionAssignmentBlocked({
                missionId: event.missionId,
                assignmentId: next.id,
                workerId: next.workerId,
                reason: `Merge conflict at fan-in: ${mergeResult.conflicts.join(', ')}`,
                source: 'advance',
              })
              publishChatEvent('assignment_blocked', {
                missionId: event.missionId,
                assignmentId: next.id,
                reason: `Merge conflict: ${mergeResult.conflicts.join(', ')}`,
              })
              continue
            }
            next.baseRef =
              mergeResult.mergedHead ?? upstreamHeads[upstreamHeads.length - 1]
            setAssignmentBaseRef(mission.id, next.id, next.baseRef)
          } catch (error) {
            console.error('[advance] fan-in merge failed', error)
            recordMissionAssignmentBlocked({
              missionId: event.missionId,
              assignmentId: next.id,
              workerId: next.workerId,
              reason: `Fan-in merge failed: ${error instanceof Error ? error.message : String(error)}`,
              source: 'advance',
            })
            continue
          }
        } else if (upstreamHeads.length === 1) {
          next.baseRef = upstreamHeads[0]
        }
      }
    }

    publishChatEvent('assignment_ready', {
      missionId: event.missionId,
      assignmentId: next.id,
      workerId: next.workerId,
    })
    void hooks?.dispatchNext?.({
      missionId: event.missionId,
      assignmentId: next.id,
    })
  }
}

/**
 * Install the MCP → mission bridge. Idempotent. Returns an uninstaller for
 * tests.
 */
export function installAdvanceBridge(hooks?: AdvanceHooks): () => void {
  // Serialize the whole critical section through the mutex queue. The hook
  // fires synchronously from task_complete; enqueueing preserves ordering
  // and snapshot isolation across concurrent terminal events.
  setOnRunTerminalHook((event) => {
    void enqueueAdvance(() => handleRunTerminal(event, hooks))
  })
  installed = true
  return () => {
    setOnRunTerminalHook(null)
    installed = false
  }
}

export function isAdvanceBridgeInstalled(): boolean {
  return installed
}
