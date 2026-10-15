/**
 * Agent presence — Multica-style dual axis (browser-safe).
 *
 * Two orthogonal dimensions (same idea as Multica `derive-presence`):
 *   1. availability — runtime/probe reachability only
 *   2. workload    — whether the agent has work on its plate right now
 *
 * Gates (needsSetup / blocked / error) are separate flags. They may override
 * the status *dot* for attention, but they do not redefine reachability.
 *
 * Provider CLI readiness (ready / not_installed) is NOT part of presence —
 * surfaces that care about install/auth use the provider-status API.
 *
 * FS / SQLite helpers live in `agent-status-io.ts` (server-only). Do not import
 * that module from client components — it pulls `node:os` via hermes-paths.
 */
import type { AgentStatus } from './agent-types'

/** Reachability only — Multica AgentAvailability (minus archived). */
export type AgentAvailability = 'online' | 'unstable' | 'offline'

/** Current work on the plate — Multica Workload. */
export type AgentWorkload = 'working' | 'queued' | 'idle'

/**
 * Folded single-axis status for filters and legacy dots.
 * Prefer {@link AgentPresence} in new UI.
 */
export type UnifiedAgentStatus =
  | 'active'
  | 'idle'
  | 'offline'
  | 'blocked'
  | 'error'
  | 'needsSetup'

export type AgentPresence = {
  availability: AgentAvailability
  workload: AgentWorkload
  needsSetup: boolean
  blocked: boolean
  error: boolean
  /** Folded display status — probe-offline wins over sticky blocked. */
  unifiedStatus: UnifiedAgentStatus
}

export type GroupChatActivity = {
  lastMessageAt: number
  online: boolean
}

/** Probe just failed but we saw life recently → Multica `recently_lost` / unstable. */
export const UNSTABLE_MS = 5 * 60 * 1000

/** Busy runtime/session without fresh output drops out of `working`. */
export const WORK_STALE_MS = 2 * 60 * 1000

/** @deprecated Use WORK_STALE_MS — kept for callers that imported the old name. */
export const ACTIVITY_STALE_MS = WORK_STALE_MS

const BUSY_STATES = new Set([
  'executing',
  'thinking',
  'writing',
  'reviewing',
  'syncing',
  'running',
  'busy',
])

const BLOCKED_STATES = new Set([
  'blocked',
  'needs_human',
  'needs_human_approval',
])

const ERROR_STATES = new Set([
  'error',
  'failed',
  'cancelled',
  'canceled',
  'killed',
])

const QUEUED_SESSION_STATES = new Set([
  'queued',
  'dispatched',
  'waiting',
  'waiting_local_directory',
])

export type AgentActivityInput = {
  runtimeState?: string | null
  runtimeLastOutputAt?: number | null
  runtimeNeedsHuman?: boolean
  runtimeBlockedReason?: string | null
  currentTask?: string | null
  missionId?: string | null
  latestSession?: { status: string; updatedAt?: number | null } | null
  /** @deprecated Not used for presence — kept for call-site compat. */
  crewOnline?: boolean
  /** @deprecated Not used for presence — kept for call-site compat. */
  groupChatLastMessageAt?: number | null
  /** @deprecated Not used for presence — kept for call-site compat. */
  groupChatOnline?: boolean
  /**
   * Gateway/runtime reachability. Sole signal for `online`.
   * When omitted, availability falls back to last-seen → unstable/offline.
   */
  probeAvailable?: boolean
  hasModel?: boolean
}

function normalizeState(state?: string | null): string {
  return (state ?? '').toLowerCase().trim()
}

/** Reachability only — probe + short unstable window from last runtime output. */
export function deriveAvailability(
  input: Pick<AgentActivityInput, 'probeAvailable' | 'runtimeLastOutputAt'>,
  nowMs: number = Date.now(),
): AgentAvailability {
  if (input.probeAvailable === true) return 'online'

  const lastSeen = input.runtimeLastOutputAt ?? 0
  if (lastSeen > 0 && nowMs - lastSeen < UNSTABLE_MS) return 'unstable'
  return 'offline'
}

/** Work on the plate right now — independent of probe. */
export function deriveWorkload(
  input: Pick<
    AgentActivityInput,
    | 'runtimeState'
    | 'runtimeLastOutputAt'
    | 'runtimeNeedsHuman'
    | 'currentTask'
    | 'missionId'
    | 'latestSession'
  >,
  nowMs: number = Date.now(),
): AgentWorkload {
  const state = normalizeState(input.runtimeState)
  const sessionStatus = normalizeState(input.latestSession?.status)
  const runtimeLast = input.runtimeLastOutputAt ?? 0
  const sessionUpdated = input.latestSession?.updatedAt ?? 0
  const freshRuntime = runtimeLast > 0 && nowMs - runtimeLast < WORK_STALE_MS
  const freshSession =
    sessionUpdated > 0 && nowMs - sessionUpdated < WORK_STALE_MS

  if (BUSY_STATES.has(state) && freshRuntime) return 'working'
  if (
    (sessionStatus === 'running' || BUSY_STATES.has(sessionStatus)) &&
    freshSession
  ) {
    return 'working'
  }

  // On the plate but not running: human gate or explicitly queued session.
  // Do NOT use sticky currentTask/missionId from runtime.json — those linger
  // after work ends and would paint every agent "queued" forever.
  if (
    input.runtimeNeedsHuman ||
    BLOCKED_STATES.has(state) ||
    QUEUED_SESSION_STATES.has(sessionStatus)
  ) {
    return 'queued'
  }

  return 'idle'
}

export function foldPresenceToUnifiedStatus(presence: {
  availability: AgentAvailability
  workload: AgentWorkload
  needsSetup: boolean
  blocked: boolean
  error: boolean
}): UnifiedAgentStatus {
  if (presence.needsSetup) return 'needsSetup'
  // Unreachable wins over sticky blocked/error (stale runtime.json).
  if (presence.availability === 'offline') return 'offline'
  if (presence.blocked) return 'blocked'
  if (presence.error) return 'error'
  if (presence.workload === 'working') return 'active'
  if (
    presence.availability === 'online' ||
    presence.availability === 'unstable'
  ) {
    return 'idle'
  }
  return 'offline'
}

export function deriveAgentPresence(
  input: AgentActivityInput,
  nowMs: number = Date.now(),
): AgentPresence {
  const state = normalizeState(input.runtimeState)
  const needsSetup = input.hasModel === false
  const blocked =
    Boolean(input.runtimeNeedsHuman) || BLOCKED_STATES.has(state)
  const error = ERROR_STATES.has(state)

  const availability = deriveAvailability(input, nowMs)
  const workload = deriveWorkload(input, nowMs)

  const presence = {
    availability,
    workload,
    needsSetup,
    blocked,
    error,
  }

  return {
    ...presence,
    unifiedStatus: foldPresenceToUnifiedStatus(presence),
  }
}

/** @deprecated Prefer {@link deriveAgentPresence}. */
export function deriveUnifiedStatus(
  input: AgentActivityInput,
  nowMs: number = Date.now(),
): UnifiedAgentStatus {
  return deriveAgentPresence(input, nowMs).unifiedStatus
}

export function toAgentStatus(status: UnifiedAgentStatus): AgentStatus {
  switch (status) {
    case 'active':
      return 'busy'
    case 'idle':
      return 'idle'
    case 'offline':
      return 'offline'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'blocked'
    case 'needsSetup':
      return 'offline'
  }
}

export function statusLabel(status: UnifiedAgentStatus): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'idle':
      return 'Idle'
    case 'offline':
      return 'Offline'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Error'
    case 'needsSetup':
      return 'Needs setup'
  }
}

export function availabilityLabel(availability: AgentAvailability): string {
  switch (availability) {
    case 'online':
      return 'Online'
    case 'unstable':
      return 'Unstable'
    case 'offline':
      return 'Offline'
  }
}

export function workloadLabel(workload: AgentWorkload): string {
  switch (workload) {
    case 'working':
      return 'Working'
    case 'queued':
      return 'Queued'
    case 'idle':
      return 'Idle'
  }
}

/**
 * Dot color priority (list indicator):
 *   needsSetup → blocked → error → availability
 * Workload never overrides the color; callers may pulse when working+online.
 */
export function presenceDotTone(presence: AgentPresence): {
  tone:
    | 'needsSetup'
    | 'blocked'
    | 'error'
    | 'online'
    | 'unstable'
    | 'offline'
  pulse: boolean
  title: string
} {
  if (presence.needsSetup) {
    return { tone: 'needsSetup', pulse: false, title: 'Needs setup' }
  }
  if (presence.availability === 'offline') {
    return { tone: 'offline', pulse: false, title: 'Offline' }
  }
  if (presence.blocked) {
    return { tone: 'blocked', pulse: false, title: 'Blocked' }
  }
  if (presence.error) {
    return { tone: 'error', pulse: false, title: 'Error' }
  }
  if (presence.availability === 'unstable') {
    return {
      tone: 'unstable',
      pulse: presence.workload === 'working',
      title:
        presence.workload === 'working'
          ? 'Unstable · Working'
          : 'Unstable',
    }
  }
  return {
    tone: 'online',
    pulse: presence.workload === 'working',
    title:
      presence.workload === 'working'
        ? 'Online · Working'
        : presence.workload === 'queued'
          ? 'Online · Queued'
          : 'Online',
  }
}
