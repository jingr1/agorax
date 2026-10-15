/**
 * Task scheduler — Symphony-inspired claim / retry / stall / concurrency
 * layered on dispatchReadyAssignments. Work source remains Mission-decomposed Tasks
 * (no tracker poll).
 */
import {
  getSwarmMission,
  listSwarmMissions,
  requeueMissionAssignment,
  type SwarmMissionAssignment,
} from '../swarm-missions'
import { dispatchReadyAssignments } from './dispatch-ready'
import { getPipelineTemplate } from './pipeline-templates'

export type SchedulerRetryKind = 'failure' | 'continuation'

export type SchedulerRetryEntry = {
  missionId: string
  assignmentId: string
  attempt: number
  dueAtMs: number
  kind: SchedulerRetryKind
  error: string | null
}

export type SchedulerRuntimeState = {
  /** assignmentId → claimed/running */
  claimed: Set<string>
  running: Map<
    string,
    { missionId: string; startedAt: number; lastEventAt: number }
  >
  retries: Map<string, SchedulerRetryEntry>
  maxConcurrent: number
  stallTimeoutMs: number
  maxRetryBackoffMs: number
}

const DEFAULT_MAX_CONCURRENT = 10
const DEFAULT_STALL_MS = 300_000
const DEFAULT_MAX_BACKOFF_MS = 300_000
const CONTINUATION_DELAY_MS = 1000

const globalState: SchedulerRuntimeState = {
  claimed: new Set(),
  running: new Map(),
  retries: new Map(),
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  stallTimeoutMs: DEFAULT_STALL_MS,
  maxRetryBackoffMs: DEFAULT_MAX_BACKOFF_MS,
}

function now(): number {
  return Date.now()
}

function retryKey(missionId: string, assignmentId: string): string {
  return `${missionId}:${assignmentId}`
}

function resolveLimits(missionId: string): {
  maxConcurrent: number
  stallTimeoutMs: number
  maxRetryBackoffMs: number
} {
  const mission = getSwarmMission(missionId)
  const template = mission?.pipelineId
    ? getPipelineTemplate(mission.pipelineId)
    : null
  const runtime = template?.runtime
  return {
    maxConcurrent:
      runtime?.maxConcurrentTasks ?? globalState.maxConcurrent,
    stallTimeoutMs: runtime?.stallTimeoutMs ?? globalState.stallTimeoutMs,
    maxRetryBackoffMs:
      runtime?.maxRetryBackoffMs ?? globalState.maxRetryBackoffMs,
  }
}

export function getSchedulerSnapshot() {
  return {
    running: [...globalState.running.entries()].map(([assignmentId, row]) => ({
      assignmentId,
      ...row,
    })),
    retrying: [...globalState.retries.values()],
    claimedCount: globalState.claimed.size,
    maxConcurrent: globalState.maxConcurrent,
  }
}

export function markTaskRunning(input: {
  missionId: string
  assignmentId: string
}): void {
  globalState.claimed.add(input.assignmentId)
  globalState.running.set(input.assignmentId, {
    missionId: input.missionId,
    startedAt: now(),
    lastEventAt: now(),
  })
  globalState.retries.delete(retryKey(input.missionId, input.assignmentId))
}

export function markTaskEvent(assignmentId: string): void {
  const row = globalState.running.get(assignmentId)
  if (row) row.lastEventAt = now()
}

export function releaseTaskClaim(assignmentId: string): void {
  globalState.claimed.delete(assignmentId)
  globalState.running.delete(assignmentId)
}

function backoffDelayMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxBackoffMs)
}

export function scheduleTaskRetry(input: {
  missionId: string
  assignmentId: string
  kind: SchedulerRetryKind
  error?: string | null
  attempt?: number
}): SchedulerRetryEntry {
  const limits = resolveLimits(input.missionId)
  const key = retryKey(input.missionId, input.assignmentId)
  const prev = globalState.retries.get(key)
  const attempt =
    input.attempt ??
    (input.kind === 'continuation' ? 1 : (prev?.attempt ?? 0) + 1)
  const delay =
    input.kind === 'continuation'
      ? CONTINUATION_DELAY_MS
      : backoffDelayMs(attempt, limits.maxRetryBackoffMs)
  const entry: SchedulerRetryEntry = {
    missionId: input.missionId,
    assignmentId: input.assignmentId,
    attempt,
    dueAtMs: now() + delay,
    kind: input.kind,
    error: input.error ?? null,
  }
  globalState.retries.set(key, entry)
  releaseTaskClaim(input.assignmentId)
  return entry
}

export function reconcileStalledTasks(nowMs = now()): Array<{
  missionId: string
  assignmentId: string
}> {
  const stalled: Array<{ missionId: string; assignmentId: string }> = []
  for (const [assignmentId, row] of globalState.running) {
    const limits = resolveLimits(row.missionId)
    if (limits.stallTimeoutMs <= 0) continue
    const elapsed = nowMs - row.lastEventAt
    if (elapsed <= limits.stallTimeoutMs) continue
    stalled.push({ missionId: row.missionId, assignmentId })
    requeueMissionAssignment({
      missionId: row.missionId,
      assignmentId,
      reason: `stall timeout after ${elapsed}ms`,
    })
    scheduleTaskRetry({
      missionId: row.missionId,
      assignmentId,
      kind: 'failure',
      error: `stalled after ${elapsed}ms`,
    })
  }
  return stalled
}

export function availableSlots(missionId?: string): number {
  const limits = missionId
    ? resolveLimits(missionId)
    : { maxConcurrent: globalState.maxConcurrent }
  return Math.max(0, limits.maxConcurrent - globalState.running.size)
}

/**
 * Dispatch ready tasks for a mission with claim + concurrency gating.
 */
export async function scheduleDispatchMission(missionId: string): Promise<{
  dispatched: Array<{ assignmentId: string; workerId: string }>
  skipped: string | null
}> {
  reconcileStalledTasks()
  if (availableSlots(missionId) <= 0) {
    return { dispatched: [], skipped: 'no available scheduler slots' }
  }
  const ready = (getSwarmMission(missionId)?.assignments ?? []).filter(
    (a) =>
      a.state === 'queued' &&
      a.dispatchable !== false &&
      !globalState.claimed.has(a.id),
  )
  // Prefer dependsOn-ready via existing dispatcher; claim after success.
  const result = await dispatchReadyAssignments(missionId)
  for (const row of result.dispatched) {
    markTaskRunning({
      missionId,
      assignmentId: row.assignmentId,
    })
  }
  return {
    dispatched: result.dispatched.map((d) => ({
      assignmentId: d.assignmentId,
      workerId: d.workerId,
    })),
    skipped: null,
  }
}

/**
 * Process due retries across missions (call from tick / after worker exit).
 */
export async function processDueRetries(nowMs = now()): Promise<number> {
  reconcileStalledTasks(nowMs)
  let count = 0
  const due = [...globalState.retries.values()].filter((r) => r.dueAtMs <= nowMs)
  for (const entry of due) {
    globalState.retries.delete(
      retryKey(entry.missionId, entry.assignmentId),
    )
    if (availableSlots(entry.missionId) <= 0) {
      scheduleTaskRetry({
        ...entry,
        error: 'no available scheduler slots',
      })
      continue
    }
    const mission = getSwarmMission(entry.missionId)
    const assignment = mission?.assignments.find(
      (a) => a.id === entry.assignmentId,
    )
    if (!assignment || assignment.dispatchable === false) continue
    if (mission?.state === 'cancelled' || mission?.state === 'done')
      continue
    await scheduleDispatchMission(entry.missionId)
    count++
  }
  return count
}

/** Test helper */
export function __resetSchedulerStateForTests(): void {
  globalState.claimed.clear()
  globalState.running.clear()
  globalState.retries.clear()
}

export function isAssignmentDispatchable(
  assignment: SwarmMissionAssignment,
): boolean {
  return assignment.dispatchable !== false
}

export function listRunnableMissions(limit = 100) {
  return listSwarmMissions(limit).filter(
    (m) => m.state === 'todo' || m.state === 'ready' || m.state === 'running',
  )
}
