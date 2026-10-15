/**
 * review — P2a 评审节点（plan 模块 1 «review.ts»）.
 *
 * A review stage parses REVIEW_OUTCOME from its checkpoint and either
 * releases the downstream (approved) or sends work back (changes_requested)
 * with the four-step rework semantics: re-dispatch reworkTarget, downstream
 * edges inherited, retry ≤ maxRework, then Human Gate.
 *
 * P2a scope: the verdict parsing + rework dispatch + retry counter. The
 * reviewer itself is a pipeline stage agent (architect) driven by the normal
 * dispatch loop; this module decides what happens AFTER its checkpoint.
 */
import {
  appendSwarmMissionOrchestratorEvent,
  getSwarmMission,
  markMissionAssignmentReviewed,
  requeueAssignmentForRework,
} from '../swarm-missions'
import { setOnCheckpointReviewHook } from './mission-hooks'
import {
  getPipelineTemplate,
} from './pipeline-templates'
import type { PipelineTemplate } from './pipeline-templates'
import type { SwarmMission, SwarmMissionAssignment } from '../swarm-missions'

export type ReviewOutcome = 'approved' | 'changes_requested'

export type ReviewDecision = {
  outcome: ReviewOutcome
  feedback: string | null
}

const DEFAULT_MAX_REWORK = 2

/** Parse REVIEW_OUTCOME from a review stage's checkpoint raw text. */
export function parseReviewOutcome(
  raw: string | null | undefined,
): ReviewDecision | null {
  if (!raw) return null
  const match = raw.match(/REVIEW_OUTCOME:\s*(approved|changes_requested)/i)
  if (!match) return null
  const outcome =
    match[1].toLowerCase() === 'approved' ? 'approved' : 'changes_requested'
  // Everything after the outcome line is reviewer feedback.
  const idx = raw.indexOf(match[0])
  const feedback = raw.slice(idx + match[0].length).trim() || null
  return { outcome, feedback }
}

function findStage(
  template: PipelineTemplate,
  stageKey: string | null | undefined,
) {
  return template.stages.find((s) => s.key === stageKey)
}

function findReworkTarget(
  mission: SwarmMission,
  reviewAssignment: SwarmMissionAssignment,
  template?: PipelineTemplate,
): SwarmMissionAssignment | null {
  let targetKey: string | null = null
  if (reviewAssignment.stageKey && template) {
    const stage = findStage(template, reviewAssignment.stageKey)
    targetKey = stage?.reworkTarget ?? null
  }
  if (!targetKey) {
    // Fallback for missions without a template or stageKey: the upstream
    // assignment this review directly depends on.
    const upstreamIds = reviewAssignment.dependsOn
    if (upstreamIds.length === 0) return null
    return (
      mission.assignments.find(
        (a) =>
          a.id === upstreamIds[upstreamIds.length - 1] &&
          a.state !== 'cancelled',
      ) ?? null
    )
  }
  // Prefer the most recent completed target assignment reachable from this
  // review. Falls back to any queued/dispatched target assignment if none
  // has checkpointed yet.
  const targetStageAssignments = mission.assignments
    .filter((a) => a.stageKey === targetKey)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  return (
    targetStageAssignments.find(
      (a) => a.checkpoint && a.state !== 'cancelled',
    ) ??
    targetStageAssignments.find((a) => a.state !== 'cancelled') ??
    null
  )
}

function reworkCount(
  mission: SwarmMission,
  reviewStageKey: string | null | undefined,
): number {
  if (!reviewStageKey) return 0
  return mission.events.filter(
    (e) =>
      e.type === 'continuation' &&
      typeof e.data?.reworkOf === 'string' &&
      e.data.reworkOf === reviewStageKey,
  ).length
}

export type ReviewApplyResult =
  | { ok: true; action: 'approved' }
  | { ok: true; action: 'rework'; targetAssignmentId: string; attempt: number }
  | { ok: true; action: 'needs_human'; reason: string }
  | { ok: false; error: string }

/**
 * Apply a review verdict to the mission. Called by the advance loop when a
 * review-kind stage checkpoints.
 *
 * approved → mark the BUILD stage's assignment reviewed (done); downstream
 *            (stages depending on the review stage) become dispatchable.
 * changes_requested → requeue the reworkTarget stage with feedback,
 *            blocking downstream. Retry > maxRework → needs_human.
 */
export function applyReviewVerdict(input: {
  missionId: string
  reviewAssignmentId: string
  rawCheckpoint: string
  reviewerId: string
  /** Optional pipeline template; when absent the engine falls back to defaults. */
  template?: PipelineTemplate
}): ReviewApplyResult {
  const mission = getSwarmMission(input.missionId)
  if (!mission)
    return { ok: false, error: `Mission not found: ${input.missionId}` }
  const reviewAssignment = mission.assignments.find(
    (a) => a.id === input.reviewAssignmentId,
  )
  if (!reviewAssignment)
    return {
      ok: false,
      error: `Assignment not found: ${input.reviewAssignmentId}`,
    }

  const decision = parseReviewOutcome(input.rawCheckpoint)
  if (!decision) return { ok: false, error: 'No REVIEW_OUTCOME in checkpoint' }

  const stage = input.template
    ? findStage(input.template, reviewAssignment.stageKey)
    : null
  const maxRework = stage?.maxRework ?? DEFAULT_MAX_REWORK

  // The build assignment is the one the review stage's reworkTarget points to.
  const buildAssignment = findReworkTarget(
    mission,
    reviewAssignment,
    input.template,
  )

  if (decision.outcome === 'approved') {
    if (buildAssignment) {
      markMissionAssignmentReviewed({
        missionId: mission.id,
        assignmentId: buildAssignment.id,
        reviewerId: input.reviewerId,
      })
    }
    return { ok: true, action: 'approved' }
  }

  // changes_requested
  if (!buildAssignment) {
    return {
      ok: false,
      error: `No rework target for review stage ${reviewAssignment.stageKey ?? input.reviewAssignmentId}`,
    }
  }

  const reviewStageKey = reviewAssignment.stageKey ?? input.reviewAssignmentId
  const attempts = reworkCount(mission, reviewStageKey)
  if (attempts >= maxRework) {
    appendSwarmMissionOrchestratorEvent({
      missionId: mission.id,
      message: `Review rework limit (${maxRework}) reached for stage ${reviewStageKey}; needs human`,
      data: { reworkOf: reviewStageKey, needsHuman: true },
    })
    return {
      ok: true,
      action: 'needs_human',
      reason: `rework limit ${maxRework} reached`,
    }
  }

  // Rework: requeue both the target stage and the review stage itself.
  // Requeueing the review stage keeps downstream (e.g. harden) blocked
  // because the review assignment is no longer terminal.
  requeueAssignmentForRework({
    missionId: mission.id,
    assignmentId: buildAssignment.id,
    reason: `changes_requested by ${input.reviewerId}: ${decision.feedback ?? '(no feedback)'}`,
  })
  requeueAssignmentForRework({
    missionId: mission.id,
    assignmentId: reviewAssignment.id,
    reason: `re-review after changes requested by ${input.reviewerId}`,
  })
  appendSwarmMissionOrchestratorEvent({
    missionId: mission.id,
    message: `Rework #${attempts + 1} for stage ${reviewStageKey}`,
    data: { reworkOf: reviewStageKey },
  })
  return {
    ok: true,
    action: 'rework',
    targetAssignmentId: buildAssignment.id,
    attempt: attempts + 1,
  }
}

// Wire the review verdict into the swarm checkpoint path (hermes / harvester).
// The MCP path already calls applyReviewVerdict explicitly in advance.ts;
// skipping 'mcp' source avoids double-processing. The guard allows tests that
// mock the mission store without stubbing every hook to import this module.
if (typeof setOnCheckpointReviewHook === 'function') {
  setOnCheckpointReviewHook(
    ({ missionId, assignmentId, workerId, checkpoint, source }) => {
      if (source === 'mcp') return
      if (!checkpoint.reviewOutcome) return
      const mission = getSwarmMission(missionId)
      const template = mission?.pipelineId
        ? getPipelineTemplate(mission.pipelineId)
        : null
      const result = applyReviewVerdict({
        missionId,
        reviewAssignmentId: assignmentId,
        rawCheckpoint: checkpoint.raw,
        reviewerId: workerId,
        template: template ?? undefined,
      })
      if (!result.ok) {
        console.error('[review] swarm-path review verdict failed:', result.error)
      }
    },
  )
}
