/**
 * Task scheduler — Symphony-inspired claim / retry / stall / concurrency
 * layered on dispatchReadyAssignments. Work source remains Mission-decomposed Tasks
 * (no tracker poll).
 */
import {
  getSwarmMission,
  listSwarmMissions,
  recordMissionAssignmentBlocked,
} from '../swarm-missions'
import { TERMINAL_ASSIGNMENT_STATES } from '../schema'
import { publishChatEvent } from '../chat-event-bus'
import { getPipelineTemplate } from './pipeline-templates'
import type { SwarmMissionAssignment } from '../swarm-missions'
import { randomUUID } from 'node:crypto'
import type { ControlPlaneStateStore, ExecutionLease } from '../control-plane-state'

export type TaskDispatchClaim = Readonly<{
  missionId: string
  assignmentId: string
}>

const dispatchClaims = new Map<string, TaskDispatchClaim>()
const waitingTasks = new Map<string, TaskDispatchClaim>()
const retryAttempts = new Map<string, number>()
const reportedStalls = new Set<string>()
let schedulerTimer: ReturnType<typeof setInterval> | null = null
let schedulerTick: Promise<void> | null = null
let stateStore: ControlPlaneStateStore | null = null
const leaseOwner = randomUUID()
const leases = new Map<string, ExecutionLease>()
const LEASE_TTL_MS = 30_000

export function configureSchedulerStateStore(store: ControlPlaneStateStore): void {
  stateStore = store
  for (const { key, value } of store.list<SchedulerRetryEntry>('scheduler-retry')) {
    globalState.retries.set(key, value)
    retryAttempts.set(key, value.attempt)
  }
  for (const { key, value } of store.list<TaskDispatchClaim>('scheduler-waiting')) waitingTasks.set(key, value)
  for (const lease of store.leases('dispatch')) {
    leases.set(lease.key, lease)
    globalState.claimed.add(lease.key)
    globalState.running.set(lease.key, { missionId: lease.groupId, startedAt: Date.now(), lastEventAt: Date.now(), started: true, recovered: true })
  }
}

function waitForCapacity(input: TaskDispatchClaim): void {
  waitingTasks.set(input.assignmentId, input)
  stateStore?.write('scheduler-waiting', input.assignmentId, input)
}

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
    {
      missionId: string
      startedAt: number
      lastEventAt: number
      started: boolean
      recovered?: boolean
    }
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
    maxConcurrent: runtime?.maxConcurrentTasks ?? globalState.maxConcurrent,
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
  reserved?: boolean
}): void {
  globalState.claimed.add(input.assignmentId)
  globalState.running.set(input.assignmentId, {
    missionId: input.missionId,
    startedAt: now(),
    lastEventAt: now(),
    started: input.reserved !== true,
  })
  globalState.retries.delete(retryKey(input.missionId, input.assignmentId))
}

export function markTaskStarted(assignmentId: string): void {
  const row = globalState.running.get(assignmentId)
  if (!row) return
  row.started = true
  markTaskEvent(assignmentId)
  retryAttempts.delete(retryKey(row.missionId, assignmentId))
  stateStore?.remove('scheduler-retry', retryKey(row.missionId, assignmentId))
}

export function markTaskEvent(assignmentId: string): void {
  const row = globalState.running.get(assignmentId)
  if (row) row.lastEventAt = now()
  reportedStalls.delete(assignmentId)
}

export function releaseTaskClaim(assignmentId: string): void {
  const lease = leases.get(assignmentId)
  if (lease && lease.owner === leaseOwner) stateStore?.release(lease)
  leases.delete(assignmentId)
  globalState.claimed.delete(assignmentId)
  globalState.running.delete(assignmentId)
  dispatchClaims.delete(assignmentId)
  reportedStalls.delete(assignmentId)
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
    (input.kind === 'continuation'
      ? 1
      : (retryAttempts.get(key) ?? prev?.attempt ?? 0) + 1)
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
  retryAttempts.set(key, attempt)
  if (attempt > 3 && input.kind === 'failure') {
    globalState.retries.delete(key)
    const assignment = getSwarmMission(input.missionId)?.assignments.find(
      (item) => item.id === input.assignmentId,
    )
    if (assignment) {
      recordMissionAssignmentBlocked({
        missionId: input.missionId,
        assignmentId: input.assignmentId,
        workerId: assignment.workerId,
        reason: `Dispatch retry limit reached: ${input.error ?? 'unknown failure'}`,
        source: 'task-scheduler',
      })
    }
  } else {
    globalState.retries.set(key, entry)
  }
  releaseTaskClaim(input.assignmentId)
  if (globalState.retries.has(key)) stateStore?.write('scheduler-retry', key, entry)
  else stateStore?.remove('scheduler-retry', key)
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
    if (reportedStalls.has(assignmentId)) continue
    const assignment = getSwarmMission(row.missionId)?.assignments.find(
      (item) => item.id === assignmentId,
    )
    if (!assignment || TERMINAL_ASSIGNMENT_STATES.includes(assignment.state))
      continue
    stalled.push({ missionId: row.missionId, assignmentId })
    reportedStalls.add(assignmentId)
    publishChatEvent('assignment_stalled', {
      missionId: row.missionId,
      assignmentId,
      elapsedMs: elapsed,
      reason: 'Execution outcome unknown; verify the runtime before retrying',
    })
  }
  return stalled
}

export function availableSlots(missionId?: string): number {
  const limits = missionId
    ? resolveLimits(missionId)
    : { maxConcurrent: globalState.maxConcurrent }
  const globalSlots = globalState.maxConcurrent - globalState.running.size
  const missionRunning = [...globalState.running.values()].filter(
    (row) => row.missionId === missionId,
  ).length
  return Math.max(
    0,
    Math.min(globalSlots, limits.maxConcurrent - missionRunning),
  )
}

export function claimTask(input: {
  missionId: string
  assignmentId: string
}): TaskDispatchClaim | null {
  if (globalState.claimed.has(input.assignmentId)) {
    waitForCapacity({ ...input })
    return null
  }
  if (globalState.retries.has(retryKey(input.missionId, input.assignmentId)))
    return null
  if (availableSlots(input.missionId) <= 0) {
    waitForCapacity({ ...input })
    return null
  }
  if (stateStore) {
    const lease = stateStore.claim({ namespace: 'dispatch', key: input.assignmentId, groupId: input.missionId, owner: leaseOwner, globalLimit: globalState.maxConcurrent, groupLimit: resolveLimits(input.missionId).maxConcurrent, ttlMs: LEASE_TTL_MS })
    if (!lease) { waitForCapacity({ ...input }); return null }
    leases.set(input.assignmentId, lease)
    stateStore.remove('scheduler-waiting', input.assignmentId)
  }
  markTaskRunning({ ...input, reserved: true })
  const claim = { ...input }
  dispatchClaims.set(input.assignmentId, claim)
  return claim
}

export function ownsTaskClaim(claim: TaskDispatchClaim): boolean {
  const lease = leases.get(claim.assignmentId)
  return dispatchClaims.get(claim.assignmentId) === claim &&
    (!stateStore || Boolean(lease && lease.owner === leaseOwner && stateStore.owns(lease)))
}

export async function tickTaskScheduler(): Promise<void> {
  if (schedulerTick) return schedulerTick
  schedulerTick = (async () => {
    for (const [assignmentId, row] of globalState.running) {
      const mission = getSwarmMission(row.missionId)
      const assignment = mission?.assignments.find(
        (item) => item.id === assignmentId,
      )
      if (
        (mission && ['done', 'cancelled'].includes(mission.state)) ||
        (assignment && TERMINAL_ASSIGNMENT_STATES.includes(assignment.state)) ||
        (row.started && !row.recovered && assignment?.state === 'queued')
      ) {
        const lease = leases.get(assignmentId)
        if (lease) stateStore?.release(lease)
        releaseTaskClaim(assignmentId)
      } else {
        const lease = leases.get(assignmentId)
        if (lease?.owner === leaseOwner) stateStore?.renew(lease, LEASE_TTL_MS)
      }
    }
    reconcileStalledTasks()
    await processDueRetries()
    for (const { missionId, assignmentId } of [...waitingTasks.values()]) {
      if (globalState.claimed.has(assignmentId)) continue
      if (availableSlots(missionId) <= 0) continue
      waitingTasks.delete(assignmentId)
      await scheduleDispatchMission(missionId, { assignmentId })
      if (!waitingTasks.has(assignmentId)) stateStore?.remove('scheduler-waiting', assignmentId)
    }
  })().finally(() => {
    schedulerTick = null
  })
  return schedulerTick
}

export function startTaskScheduler(store?: ControlPlaneStateStore): void {
  if (schedulerTimer) return
  if (store) configureSchedulerStateStore(store)
  for (let offset = 0; ; offset += 100) {
    const missions = listSwarmMissions(100, offset)
    for (const mission of missions) {
      for (const assignment of mission.assignments) {
        if (['dispatched', 'reviewing'].includes(assignment.state)) {
          if (globalState.claimed.has(assignment.id)) continue
          if (stateStore) {
            const lease = stateStore.claim({ namespace: 'dispatch', key: assignment.id, groupId: mission.id, owner: leaseOwner, globalLimit: Number.MAX_SAFE_INTEGER, groupLimit: Number.MAX_SAFE_INTEGER, ttlMs: LEASE_TTL_MS })
            if (lease) leases.set(assignment.id, lease)
          }
          markTaskRunning({
            missionId: mission.id,
            assignmentId: assignment.id,
          })
        }
      }
    }
    if (missions.length < 100) break
  }
  schedulerTimer = setInterval(() => {
    for (const lease of leases.values()) {
      if (lease.owner === leaseOwner) stateStore?.renew(lease, LEASE_TTL_MS)
    }
    void tickTaskScheduler().catch((error) => {
      console.error('[task-scheduler] tick failed:', error)
    })
  }, 1000)
  schedulerTimer.unref()
}

export function stopTaskScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = null
}

/**
 * Dispatch ready tasks for a mission with claim + concurrency gating.
 */
export async function scheduleDispatchMission(
  missionId: string,
  options?: { assignmentId?: string },
): Promise<{
  dispatched: Array<{ assignmentId: string; workerId: string }>
  skipped: string | null
}> {
  const { dispatchReadyAssignments } = await import('./dispatch-ready')
  const result = await dispatchReadyAssignments(missionId, options)
  return {
    dispatched: result.dispatched
      .filter((row) => row.ok)
      .map((d) => ({
        assignmentId: d.assignmentId,
        workerId: d.workerId,
      })),
    skipped:
      result.dispatched.length === 0 && availableSlots(missionId) <= 0
        ? 'no available scheduler slots'
        : null,
  }
}

/**
 * Process due retries across missions (call from tick / after worker exit).
 */
export async function processDueRetries(nowMs = now()): Promise<number> {
  let count = 0
  const due = [...globalState.retries.values()].filter(
    (r) => r.dueAtMs <= nowMs,
  )
  for (const entry of due) {
    globalState.retries.delete(retryKey(entry.missionId, entry.assignmentId))
    if (availableSlots(entry.missionId) <= 0) {
      const postponed = {
        ...entry,
        dueAtMs: nowMs + CONTINUATION_DELAY_MS,
      }
      globalState.retries.set(retryKey(entry.missionId, entry.assignmentId), postponed)
      stateStore?.write('scheduler-retry', retryKey(entry.missionId, entry.assignmentId), postponed)
      continue
    }
    const mission = getSwarmMission(entry.missionId)
    const assignment = mission?.assignments.find(
      (a) => a.id === entry.assignmentId,
    )
    if (
      !assignment ||
      assignment.state !== 'queued' ||
      assignment.dispatchable === false
    ) {
      stateStore?.remove('scheduler-retry', retryKey(entry.missionId, entry.assignmentId))
      continue
    }
    if (mission?.state === 'cancelled' || mission?.state === 'done') {
      stateStore?.remove('scheduler-retry', retryKey(entry.missionId, entry.assignmentId))
      continue
    }
    await scheduleDispatchMission(entry.missionId, {
      assignmentId: entry.assignmentId,
    })
    count++
  }
  return count
}

/** Test helper */
export function __resetSchedulerStateForTests(): void {
  stopTaskScheduler()
  globalState.claimed.clear()
  globalState.running.clear()
  globalState.retries.clear()
  dispatchClaims.clear()
  waitingTasks.clear()
  retryAttempts.clear()
  reportedStalls.clear()
  leases.clear()
  stateStore = null
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

if (import.meta.hot) {
  import.meta.hot.dispose(stopTaskScheduler)
}
