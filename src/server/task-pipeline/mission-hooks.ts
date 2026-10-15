import type { ParsedSwarmCheckpoint } from '../swarm-checkpoints'

type CheckpointHookInput = {
  missionId: string
  assignmentId: string
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}

type CheckpointTerminalHook = (input: CheckpointHookInput) => void | Promise<void>
type CheckpointReviewHook = (input: CheckpointHookInput) => void | Promise<void>

let onCheckpointTerminal: CheckpointTerminalHook | null = null
let onCheckpointReview: CheckpointReviewHook | null = null

export function setOnCheckpointTerminalHook(
  hook: CheckpointTerminalHook | null,
): void {
  onCheckpointTerminal = hook
}

export function setOnCheckpointReviewHook(
  hook: CheckpointReviewHook | null,
): void {
  onCheckpointReview = hook
}

function toInput(
  missionId: string,
  assignmentId: string,
  workerId: string,
  checkpoint: ParsedSwarmCheckpoint,
  source?: string | null,
): CheckpointHookInput {
  return { missionId, assignmentId, workerId, checkpoint, source }
}

export function fireCheckpointReviewHook(
  missionId: string,
  assignmentId: string,
  workerId: string,
  checkpoint: ParsedSwarmCheckpoint,
  source?: string | null,
): void {
  if (!onCheckpointReview) return
  Promise.resolve(
    onCheckpointReview(toInput(missionId, assignmentId, workerId, checkpoint, source)),
  ).catch((error) => {
    console.error(
      '[mission-hooks] review hook failed:',
      error instanceof Error ? error.message : String(error),
    )
  })
}

export function fireCheckpointTerminalHook(
  missionId: string,
  assignmentId: string,
  workerId: string,
  checkpoint: ParsedSwarmCheckpoint,
  source?: string | null,
): void {
  if (!onCheckpointTerminal) return
  Promise.resolve(
    onCheckpointTerminal(toInput(missionId, assignmentId, workerId, checkpoint, source)),
  ).catch((error) => {
    console.error(
      '[mission-hooks] terminal hook failed:',
      error instanceof Error ? error.message : String(error),
    )
  })
}
