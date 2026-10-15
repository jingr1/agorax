import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  newestCheckpointFromMessages,
  parseSwarmCheckpoint,
  type ParsedSwarmCheckpoint,
} from '../../server/swarm-checkpoints'
import { readWorkerMessages } from '../../server/swarm-chat-reader'
import {
  createOrUpdateMission,
  getSwarmMission,
  markMissionAssignmentDispatched,
  recordMissionAssignmentBlocked,
  recordMissionCheckpoint,
} from '../../server/swarm-missions'
import {
  appendSwarmMemoryEvent,
  buildSwarmStartupSnapshot,
} from '../../server/swarm-memory'
import {
  rosterByWorkerId,
  type SwarmRosterWorker,
} from '../../server/swarm-roster'
import { publishSwarmCheckpointNotification } from '../../server/swarm-notifications'
import { isSwarmDispatchWorkerId } from '../../lib/swarm-workers'
import { ensureSwarmProfileConfig } from '../../server/swarm-profile-config'
import {
  buildHermesChatQueryArgs,
} from '../../server/swarm-chat-command'
import { buildHandoff, writeHandoff } from '../../server/handoff'
import { harvestSwarmWorkers } from '../../server/swarm-harvest'
import {
  buildMissionArtifactInstructions,
  ensureSwarmMissionArtifactDirs,
  rewriteLegacyOutputPathsInText,
} from '../../server/swarm-mission-artifacts'
import {
  buildHermesTmuxShellCommand,
  buildHermesTmuxTuiCommand,
  resolveTmuxTransportMode,
  shellEscapeSingle,
  tmuxPaneLooksLikeHermesTui,
  tmuxPaneLooksLikeShellReady,
  tmuxPasteWithBracketedPaste,
  tmuxPaneTarget,
  tmuxSessionHasPane,
  type TmuxTransportMode,
} from '../../server/swarm-tmux-delivery'

export { buildHermesChatQueryArgs } from '../../server/swarm-chat-command'

const HERMES_BIN_CANDIDATES = [
  process.env.HERMES_CLI_BIN,
  join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
  join(homedir(), '.local', 'bin', 'hermes'),
  'hermes',
].filter((value): value is string => Boolean(value))

function resolveHermesBin(): string {
  for (const candidate of HERMES_BIN_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    return candidate
  }
  return 'hermes'
}

type AssignmentRequest = {
  workerId: string
  task: string
  rationale?: string
  assignmentId?: string
  dependsOn?: Array<string>
  reviewRequired?: boolean
  direct?: boolean
}

export type SwarmDeliveryMode = 'tmux-tui' | 'tmux-cli' | 'oneshot'
/** @deprecated alias — resolves to tmux-tui or tmux-cli via HERMES_SWARM_TMUX_MODE */
export type SwarmDeliveryModeLegacy = 'tmux'
export type SwarmDeliveryModeRequest =
  | SwarmDeliveryMode
  | SwarmDeliveryModeLegacy
  | 'auto'
export type SwarmDeliveryFallback = 'tmux_unavailable'

type DispatchRequest = {
  workerIds?: unknown
  prompt?: unknown
  assignments?: unknown
  timeoutSeconds?: unknown
  waitForCheckpoint?: unknown
  allowAsync?: unknown
  checkpointPollSeconds?: unknown
  missionId?: unknown
  missionTitle?: unknown
  direct?: unknown
  notifySessionKey?: unknown
  deliveryMode?: unknown
}

export function resolveWaitForCheckpoint(
  body: Pick<DispatchRequest, 'waitForCheckpoint' | 'allowAsync'>,
): boolean {
  if (body.waitForCheckpoint === true) return true
  if (body.waitForCheckpoint === false || body.allowAsync === true) return false
  return true
}

type WorkerResult = {
  workerId: string
  ok: boolean
  output: string
  error: string | null
  durationMs: number
  exitCode: number | null
  delivery?: SwarmDeliveryMode
  deliveryFallback?: SwarmDeliveryFallback | null
  checkpoint?: ParsedSwarmCheckpoint | null
  checkpointStatus?: 'checkpointed' | 'timeout' | 'not-requested'
}

type ResolvedDelivery = {
  mode: SwarmDeliveryMode
  fallback: SwarmDeliveryFallback | null
}

let warnedDeprecatedUseLive = false

function warnIfDeprecatedUseLive(): void {
  if (warnedDeprecatedUseLive) return
  const legacy = process.env.HERMES_SWARM_USE_LIVE
  if (legacy === '1' || legacy === 'true') {
    warnedDeprecatedUseLive = true
    console.warn(
      '[swarm-dispatch] HERMES_SWARM_USE_LIVE is deprecated: tmux delivery is now the default. ' +
        'Use HERMES_SWARM_FORCE_ONESHOT=1 to force wrapper oneshot instead.',
    )
  }
}

function resolveTmuxDeliveryMode(
  transport?: TmuxTransportMode | null,
): SwarmDeliveryMode {
  return resolveTmuxTransportMode(transport) === 'cli' ? 'tmux-cli' : 'tmux-tui'
}

export function resolveDeliveryMode(
  requestMode?: SwarmDeliveryModeRequest,
  options?: { tmuxAvailable?: boolean },
): ResolvedDelivery {
  warnIfDeprecatedUseLive()
  if (requestMode === 'oneshot') {
    return { mode: 'oneshot', fallback: null }
  }
  if (requestMode === 'tmux-cli') {
    return { mode: 'tmux-cli', fallback: null }
  }
  if (requestMode === 'tmux-tui') {
    return { mode: 'tmux-tui', fallback: null }
  }
  if (requestMode === 'tmux') {
    return { mode: resolveTmuxDeliveryMode(), fallback: null }
  }
  if (
    process.env.HERMES_SWARM_FORCE_ONESHOT === '1' ||
    process.env.HERMES_SWARM_FORCE_ONESHOT === 'true'
  ) {
    return { mode: 'oneshot', fallback: null }
  }
  const tmuxAvailable = options?.tmuxAvailable ?? resolveTmuxBin() !== null
  if (!tmuxAvailable) {
    return { mode: 'oneshot', fallback: 'tmux_unavailable' }
  }
  return { mode: resolveTmuxDeliveryMode(), fallback: null }
}

function parseDeliveryModeRequest(value: unknown): SwarmDeliveryModeRequest {
  if (
    value === 'tmux' ||
    value === 'tmux-tui' ||
    value === 'tmux-cli' ||
    value === 'oneshot' ||
    value === 'auto'
  ) {
    return value
  }
  return 'auto'
}

type RuntimeCheckpointSnapshot = {
  checkpointStatus:
    | 'none'
    | 'in_progress'
    | 'done'
    | 'blocked'
    | 'handoff'
    | 'needs_input'
  state: string | null
  lastSummary: string | null
  lastResult: string | null
  nextAction: string | null
  blockedReason: string | null
  lastCheckIn: string | null
  lastOutputAt: number | null
  checkpointRaw: string | null
  checkpointTimestamp: number
}

const MAX_PROMPT_CHARS = 32_000
const MAX_OUTPUT_CHARS = 200_000
const DEFAULT_TIMEOUT_S = 240
const MAX_TIMEOUT_S = 600

function getProfilesDir(): string {
  const base = process.env.HERMES_HOME
  if (base) {
    const parts = base.split('/').filter(Boolean)
    if (parts.length >= 2 && parts.at(-2) === 'profiles') {
      return base.split('/').slice(0, -1).join('/')
    }
    return join(base, 'profiles')
  }
  return join(homedir(), '.hermes', 'profiles')
}

function getWrapperPath(workerId: string): string {
  const worker = rosterByWorkerId([workerId]).get(workerId)
  const wrapperName = worker?.wrapper?.trim() || workerId
  const mockBinDir = process.env.HERMES_SWARM_MOCK_BIN
  if (mockBinDir && existsSync(join(mockBinDir, wrapperName))) {
    return join(mockBinDir, wrapperName)
  }
  return join(homedir(), '.local', 'bin', wrapperName)
}

function getProfilePath(workerId: string): string {
  return join(getProfilesDir(), workerId)
}

function validateWorkerId(workerId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workerId)
}

const TMUX_BIN_CANDIDATES = [
  process.env.TMUX_BIN,
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  join(homedir(), '.local', 'bin', 'tmux'),
  'tmux',
].filter((value): value is string => Boolean(value))

export function resolveTmuxBin(): string | null {
  // Allow operators on non-standard installs (Docker, NixOS, custom
  // package layouts) to point Swarm at the right tmux binary without
  // patching this list. See #244.
  const override = process.env.HERMES_TMUX_BIN || process.env.CLAUDE_TMUX_BIN
  if (override) {
    if (existsSync(override)) return override
    // If the override looks like a bare command (no slashes), trust it
    // and let execFile resolve it via PATH.
    if (!override.includes('/')) return override
  }
  for (const candidate of TMUX_BIN_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) {
        return candidate
      }
      continue
    }
    return candidate
  }
  return null
}

function tmuxHasSession(tmuxBin: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(tmuxBin, ['has-session', '-t', name], (error) => {
      resolve(!error)
    })
  })
}

function tmuxSessionUsable(tmuxBin: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(tmuxBin, ['list-panes', '-t', name], (error) => {
      resolve(!error)
    })
  })
}

function tmuxKillSession(tmuxBin: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(tmuxBin, ['kill-session', '-t', name], () => resolve())
  })
}

function execFileAsync(
  cmd: string,
  args: Array<string>,
  timeout = 8_000,
  input?: string,
): Promise<
  { ok: true; stdout: string; stderr: string } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer: MAX_OUTPUT_CHARS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: stderr?.toString().trim() || error.message,
          })
          return
        }
        resolve({
          ok: true,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        })
      },
    )
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sessionNameFor(workerId: string): string {
  return `swarm-${workerId}`
}

function resolveGithubToken(): string | null {
  const direct = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (direct && direct.trim()) return direct.trim()
  return null
}

/** @deprecated use buildHermesTmuxTuiCommand({ useExec: false }) */
export function buildHermesTmuxLaunchCommand(input: {
  profilePath: string
  hermesBin: string
  ghToken?: string | null
}): string {
  return buildHermesTmuxTuiCommand({ ...input, useExec: false })
}

/** @deprecated use buildHermesTmuxTuiCommand({ useExec: true }) */
export function buildHermesTmuxExecCommand(input: {
  profilePath: string
  hermesBin: string
  ghToken?: string | null
}): string {
  return buildHermesTmuxTuiCommand({ ...input, useExec: true })
}

export { tmuxPaneLooksLikeHermesTui, tmuxPaneLooksLikeShellReady }

function parseAssignments(value: unknown): Array<AssignmentRequest> {
  if (!Array.isArray(value)) return []
  const assignments: Array<AssignmentRequest> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const workerId = typeof obj.workerId === 'string' ? obj.workerId.trim() : ''
    const task = typeof obj.task === 'string' ? obj.task.trim() : ''
    const rationale =
      typeof obj.rationale === 'string' ? obj.rationale.trim() : undefined
    const dependsOn = Array.isArray(obj.dependsOn)
      ? obj.dependsOn.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
      : undefined
    const reviewRequired =
      typeof obj.reviewRequired === 'boolean' ? obj.reviewRequired : undefined
    const direct = typeof obj.direct === 'boolean' ? obj.direct : undefined
    if (
      !workerId ||
      !task ||
      !validateWorkerId(workerId) ||
      !isSwarmDispatchWorkerId(workerId)
    )
      continue
    assignments.push({
      workerId,
      task,
      rationale,
      dependsOn,
      reviewRequired,
      direct,
    })
  }
  return assignments
}

function readRuntimeJson(profilePath: string): Record<string, unknown> {
  const runtimePath = join(profilePath, 'runtime.json')
  if (!existsSync(runtimePath)) return {}
  try {
    return JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

/**
 * Build and persist a structured handoff for a completed worker checkpoint.
 * Non-blocking: failures are logged but do not break dispatch.
 */
async function recordHandoffForWorker(
  workerId: string,
  checkpoint: ParsedSwarmCheckpoint,
): Promise<void> {
  try {
    const runtime = readRuntimeJson(getProfilePath(workerId))
    const handoff = await buildHandoff(workerId, checkpoint, runtime)
    await writeHandoff(handoff)
  } catch (err) {
    console.error(`[handoff] failed for ${workerId}:`, err)
  }
}

function writeRuntimePatch(
  workerId: string,
  patch: Record<string, unknown>,
): void {
  const profilePath = getProfilePath(workerId)
  mkdirSync(profilePath, { recursive: true })
  const runtimePath = join(profilePath, 'runtime.json')
  const current = readRuntimeJson(profilePath)
  const next = {
    ...current,
    workerId,
    ...patch,
  }
  writeFileSync(runtimePath, JSON.stringify(next, null, 2) + '\n')
}

function cleanRuntimeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function cleanRuntimeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function cleanRuntimeCheckpointStatus(
  value: unknown,
): RuntimeCheckpointSnapshot['checkpointStatus'] {
  return value === 'in_progress' ||
    value === 'done' ||
    value === 'blocked' ||
    value === 'handoff' ||
    value === 'needs_input'
    ? value
    : 'none'
}

export function readRuntimeCheckpointSnapshot(
  profilePath: string,
): RuntimeCheckpointSnapshot {
  const raw = readRuntimeJson(profilePath)
  return {
    checkpointStatus: cleanRuntimeCheckpointStatus(raw.checkpointStatus),
    state: cleanRuntimeText(raw.state),
    lastSummary: cleanRuntimeText(raw.lastSummary),
    lastResult: cleanRuntimeText(raw.lastResult),
    nextAction: cleanRuntimeText(raw.nextAction),
    blockedReason: cleanRuntimeText(raw.blockedReason),
    lastCheckIn: cleanRuntimeText(raw.lastCheckIn),
    lastOutputAt: cleanRuntimeNumber(raw.lastOutputAt),
    checkpointRaw: cleanRuntimeText(raw.checkpointRaw),
    checkpointTimestamp: Math.max(
      cleanRuntimeNumber(raw.lastOutputAt) ?? 0,
      isoToMs(typeof raw.lastCheckIn === 'string' ? raw.lastCheckIn : null) ??
        0,
      cleanRuntimeNumber(raw.lastDispatchAt) ?? 0,
    ),
  }
}

export function runtimeCheckpointSignature(
  snapshot: RuntimeCheckpointSnapshot,
): string {
  return JSON.stringify(snapshot)
}

function isoToMs(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stateLabelForRuntimeSnapshot(
  snapshot: RuntimeCheckpointSnapshot,
): ParsedSwarmCheckpoint['stateLabel'] | null {
  switch (snapshot.checkpointStatus) {
    case 'done':
      return 'DONE'
    case 'blocked':
      return 'BLOCKED'
    case 'needs_input':
      return 'NEEDS_INPUT'
    case 'handoff':
      return 'HANDOFF'
    case 'in_progress':
      return 'IN_PROGRESS'
    default:
      break
  }
  const state = snapshot.state?.toLowerCase()
  if (state === 'blocked') return 'BLOCKED'
  if (state === 'waiting') return 'NEEDS_INPUT'
  if (
    state === 'executing' ||
    state === 'thinking' ||
    state === 'writing' ||
    state === 'reviewing' ||
    state === 'syncing'
  )
    return 'IN_PROGRESS'
  if (state === 'idle') return 'DONE'
  return null
}

function runtimeSnapshotHasMeaningfulCheckpoint(
  snapshot: RuntimeCheckpointSnapshot,
): boolean {
  return Boolean(
    snapshot.checkpointRaw ||
    snapshot.lastSummary ||
    snapshot.lastResult ||
    snapshot.nextAction ||
    snapshot.blockedReason,
  )
}

export function runtimeSnapshotIsFresh(
  snapshot: RuntimeCheckpointSnapshot,
  baselineSignature: string,
  dispatchedAt: number,
): boolean {
  const changed = runtimeCheckpointSignature(snapshot) !== baselineSignature
  if (!changed) return false
  const outputAt = snapshot.lastOutputAt
  const checkInAt = isoToMs(snapshot.lastCheckIn)
  // Allow a small clock skew between Date.now() used for dispatchedAt and the
  // ISO timestamp written by markDispatchStarted.
  const freshThreshold = dispatchedAt - 1000
  return Boolean(
    (typeof outputAt === 'number' && outputAt >= freshThreshold) ||
    (typeof checkInAt === 'number' && checkInAt >= freshThreshold),
  )
}

function formatRuntimeCheckpointRaw(checkpoint: ParsedSwarmCheckpoint): string {
  return [
    `STATE: ${checkpoint.stateLabel}`,
    `FILES_CHANGED: ${checkpoint.filesChanged ?? 'none'}`,
    `COMMANDS_RUN: ${checkpoint.commandsRun ?? 'none'}`,
    `RESULT: ${checkpoint.result ?? 'none'}`,
    `BLOCKER: ${checkpoint.blocker ?? 'none'}`,
    `NEXT_ACTION: ${checkpoint.nextAction ?? 'none'}`,
  ].join('\n')
}

export function checkpointFromRuntimeSnapshot(
  snapshot: RuntimeCheckpointSnapshot,
): ParsedSwarmCheckpoint | null {
  const stateLabel = stateLabelForRuntimeSnapshot(snapshot)
  if (!stateLabel || !runtimeSnapshotHasMeaningfulCheckpoint(snapshot))
    return null
  const result = snapshot.lastResult ?? snapshot.lastSummary
  const blocker = snapshot.blockedReason
  const checkpoint: ParsedSwarmCheckpoint = {
    stateLabel,
    runtimeState:
      stateLabel === 'DONE' || stateLabel === 'HANDOFF'
        ? 'idle'
        : stateLabel === 'BLOCKED'
          ? 'blocked'
          : stateLabel === 'NEEDS_INPUT'
            ? 'waiting'
            : 'executing',
    checkpointStatus:
      stateLabel === 'DONE'
        ? 'done'
        : stateLabel === 'BLOCKED'
          ? 'blocked'
          : stateLabel === 'NEEDS_INPUT'
            ? 'needs_input'
            : stateLabel === 'HANDOFF'
              ? 'handoff'
              : 'in_progress',
    filesChanged: null,
    commandsRun: null,
    result,
    blocker,
    nextAction: snapshot.nextAction,
    reviewOutcome: null,
    raw: '',
  }
  checkpoint.raw = formatRuntimeCheckpointRaw(checkpoint)
  return checkpoint
}

export function buildWorkerPrompt(input: {
  workerId: string
  task: string
  rationale?: string
  roster?: SwarmRosterWorker
  direct?: boolean
  raw?: boolean
  missionId?: string | null
  taskTitle?: string | null
}): string {
  if (input.direct && input.raw) return input.task
  const roster = input.roster
  const displayName = roster?.name?.trim() || input.workerId
  const role = roster?.role || 'Worker'
  const humanLabel = `${displayName} — ${role}`
  const skills = roster?.skills?.length
    ? roster.skills.join(', ')
    : 'swarm-worker-core'
  const capabilities = roster?.capabilities?.length
    ? roster.capabilities.join(', ')
    : 'not declared'
  const mission =
    roster?.mission || 'Execute assigned swarm tasks and checkpoint progress.'
  const specialty = roster?.specialty || 'General execution'

  let snapshotSection = ''
  try {
    const snapshot = buildSwarmStartupSnapshot({
      workerId: input.workerId,
      role,
      specialty,
      rosterMission: mission,
      taskTitle: input.taskTitle ?? null,
      missionId: input.missionId ?? null,
    })
    snapshotSection = snapshot.rendered
  } catch {
    snapshotSection = ''
  }

  const lines: Array<string> = [
    '## Swarm Orchestrator Dispatch',
    `Worker: ${humanLabel}`,
    `Machine ID: ${input.workerId}`,
    `Specialty: ${specialty}`,
    `Mission: ${mission}`,
    `Skills: ${skills}`,
    `Capabilities: ${capabilities}`,
    input.rationale ? `Routing rationale: ${input.rationale}` : '',
    '',
  ]
  if (snapshotSection) {
    lines.push(snapshotSection)
    lines.push('')
  }
  const missionId = input.missionId?.trim() || null
  const taskText = missionId
    ? rewriteLegacyOutputPathsInText(input.task, missionId)
    : input.task
  lines.push('## Assigned Task', taskText, '')
  if (missionId) {
    lines.push(buildMissionArtifactInstructions(missionId, input.workerId), '')
  }
  lines.push(
    '## Operating Rules',
    '- Work in your persistent Hermes worker session and preserve your profile context.',
    `- The Worker Startup Memory Snapshot above is your authoritative starting context. If you have filesystem tools, also read \`~/.\u0068\u0065\u0072\u006d\u0065\u0073/profiles/${input.workerId}/MEMORY.md\`, \`SOUL.md\`, \`USER.md\`, and \`memory/IDENTITY.md\` for full detail.`,
    `- Search your own memory before starting if relevant: GET /api/swarm-memory/search?workerId=${input.workerId}&q=<term>.`,
    '- Do not blame a generic sandbox for missing access. Assume repo/filesystem/network are available unless a command proves otherwise. If auth or tools fail, report the exact failing command and exact missing token/tool/env.',
    '- Produce concrete artifacts or a concrete checkpoint; avoid vague status updates.',
    '- If you are blocked, say exactly what is missing and the smallest unblock action.',
    '- If this is part of a larger workflow, stop after your checkpoint and wait for orchestrator continuation.',
    `- If context pressure is high, write a session snapshot to ~/.hermes/profiles/${input.workerId}/memory/session-snapshots/<missionId>.md before /new and continue from it on resume. Cross-worker handoffs use memory/handoffs/swarm/${input.workerId}-latest.md (platform-managed).`,
    '',
    '## Required Checkpoint Format',
    'STATE: DONE | BLOCKED | NEEDS_INPUT | HANDOFF | IN_PROGRESS',
    'FILES_CHANGED: exact paths or none',
    'COMMANDS_RUN: exact commands or none',
    'RESULT: concrete result/proof',
    'BLOCKER: blocker or none',
    'NEXT_ACTION: exact recommended next action',
  )
  return lines.filter(Boolean).join('\n')
}

function markDispatchStarted(
  workerId: string,
  task: string,
  missionId?: string | null,
  assignmentId?: string | null,
  notifySessionKey?: string | null,
): void {
  if (missionId) {
    ensureSwarmMissionArtifactDirs(missionId, workerId)
  }
  const controlMessage = `Dispatched task: ${task.slice(0, 180)}`
  writeRuntimePatch(workerId, {
    state: 'running',
    phase: 'dispatched',
    currentTask: task,
    currentMissionId: missionId ?? null,
    currentAssignmentId: assignmentId ?? null,
    checkpointStatus: 'in_progress',
    needsHuman: false,
    blockedReason: null,
    lastDispatchAt: Date.now(),
    lastDispatchMode: 'tmux',
    lastDispatchResult: 'Dispatch queued',
    lastCheckIn: new Date().toISOString(),
    lastSummary: controlMessage,
    lastControlMessage: controlMessage,
    nextAction:
      'Worker should execute and return the required checkpoint format.',
    notifySessionKey: notifySessionKey ?? 'main',
    // Clear stale checkpoint and processed marker so harvest does not pick up
    // the previous task's DONE as the result for this new dispatch.
    // Also clear lastOutputAt so the stale-threshold check in runWorkerLoop
    // falls back to lastDispatchAt (just set above) instead of a timestamp
    // from a previous run that would make the worker appear stale immediately.
    checkpointRaw: null,
    orchestratorProcessedRaw: null,
    lastOutputAt: null,
  })
}

function markDispatchResult(workerId: string, result: WorkerResult): void {
  writeRuntimePatch(workerId, {
    lastDispatchAt: Date.now(),
    lastDispatchMode: result.delivery ?? 'none',
    lastDispatchResult: result.ok
      ? result.output.slice(0, 500)
      : (result.error ?? 'dispatch failed').slice(0, 500),
    state: result.ok ? 'executing' : 'blocked',
    checkpointStatus: result.ok ? 'in_progress' : 'blocked',
    blockedReason: result.ok ? null : result.error,
    lastCheckIn: new Date().toISOString(),
  })
}

export function dispatchBlockReason(
  result: Pick<WorkerResult, 'ok' | 'error' | 'output' | 'checkpointStatus'>,
): string | null {
  if (!result.ok)
    return (
      result.error?.trim() ||
      result.output?.trim() ||
      'Dispatch failed before a worker checkpoint was recorded.'
    )
  if (result.checkpointStatus === 'timeout')
    return 'No fresh checkpoint before poll timeout.'
  return null
}

function recordDispatchBlock(
  workerId: string,
  assignment: AssignmentRequest,
  result: WorkerResult,
  options?: { missionId?: string | null },
): void {
  const reason = dispatchBlockReason(result)
  if (!reason) return
  recordMissionAssignmentBlocked({
    missionId: options?.missionId,
    assignmentId: assignment.assignmentId ?? null,
    workerId,
    reason,
    source: 'swarm-dispatch',
  })
  writeRuntimePatch(workerId, {
    state: 'blocked',
    phase: 'blocked',
    checkpointStatus: 'blocked',
    blockedReason: reason,
    lastDispatchResult: reason,
    lastCheckIn: new Date().toISOString(),
    lastOutputAt: Date.now(),
  })
}

function markCheckpointResult(
  workerId: string,
  checkpoint: ParsedSwarmCheckpoint,
  notifySessionKey?: string | null,
): void {
  // When the checkpoint reaches any terminal status (anything other than
  // 'in_progress' — i.e. done/blocked/needs_input/handoff) the worker is no
  // longer running this task, so clear currentTask the same way mission cancel
  // resets it. While still in_progress we omit the key entirely so
  // writeRuntimePatch keeps the existing currentTask untouched.
  const clearCurrentTask = checkpoint.checkpointStatus !== 'in_progress'
  writeRuntimePatch(workerId, {
    state: checkpoint.runtimeState,
    phase: checkpoint.stateLabel.toLowerCase(),
    checkpointStatus: checkpoint.checkpointStatus,
    ...(clearCurrentTask ? { currentTask: null } : {}),
    lastCheckIn: new Date().toISOString(),
    lastOutputAt: Date.now(),
    lastSummary: checkpoint.result,
    lastResult: checkpoint.result,
    lastRealSummary: checkpoint.result,
    lastRealResult: checkpoint.result,
    lastControlMessage: null,
    nextAction: checkpoint.nextAction,
    blockedReason:
      checkpoint.stateLabel === 'BLOCKED' ||
      checkpoint.stateLabel === 'NEEDS_INPUT'
        ? checkpoint.blocker
        : null,
    needsHuman: checkpoint.stateLabel === 'NEEDS_INPUT',
    checkpointRaw: checkpoint.raw,
    checkpointFilesChanged: checkpoint.filesChanged,
    checkpointCommandsRun: checkpoint.commandsRun,
    notifySessionKey: notifySessionKey ?? 'main',
  })
}

type CheckpointDispatchContext = {
  workerId: string
  assignment: AssignmentRequest
  missionId?: string | null
  notifySessionKey?: string | null
  previousRaw: string | null
  baselineRuntimeSignature: string
  dispatchedAt: number
  checkpointPollMs: number
}

async function attachCheckpointToResult(
  result: WorkerResult,
  context: CheckpointDispatchContext,
  initialCheckpoint: ParsedSwarmCheckpoint | null,
): Promise<WorkerResult> {
  let checkpoint = initialCheckpoint
  if (!checkpoint) {
    checkpoint = await waitForFreshCheckpoint(
      context.workerId,
      context.previousRaw,
      context.baselineRuntimeSignature,
      context.dispatchedAt,
      context.checkpointPollMs,
    )
  }

  if (checkpoint) {
    markCheckpointResult(
      context.workerId,
      checkpoint,
      context.notifySessionKey ?? 'main',
    )
    const updatedMission = recordMissionCheckpoint({
      missionId: context.missionId,
      assignmentId: context.assignment.assignmentId ?? null,
      workerId: context.workerId,
      checkpoint,
      source: 'swarm-dispatch',
    })
    if (updatedMission?._completed) {
      try {
        for (const wId of new Set(
          updatedMission.assignments.map((a) => a.workerId),
        )) {
          appendSwarmMemoryEvent({
            workerId: wId,
            missionId: updatedMission.id,
            type: 'complete',
            title: updatedMission.title,
            summary: `Mission complete: ${updatedMission.title}`,
          })
        }
      } catch {
        /* memory write best-effort */
      }
    }
    appendSwarmMemoryEvent({
      workerId: context.workerId,
      missionId: context.missionId ?? null,
      assignmentId: context.assignment.assignmentId ?? null,
      type: 'checkpoint',
      summary: checkpoint.result ?? `Checkpoint ${checkpoint.stateLabel}`,
      checkpoint,
      event: {
        stateLabel: checkpoint.stateLabel,
        filesChanged: checkpoint.filesChanged,
        commandsRun: checkpoint.commandsRun,
        blocker: checkpoint.blocker,
        nextAction: checkpoint.nextAction,
      },
    })
    publishSwarmCheckpointNotification({
      workerId: context.workerId,
      missionId: context.missionId ?? null,
      assignmentId: context.assignment.assignmentId ?? null,
      checkpoint,
      notifySessionKey: context.notifySessionKey ?? 'main',
    })
    await recordHandoffForWorker(context.workerId, checkpoint)
    return {
      ...result,
      checkpoint,
      checkpointStatus: 'checkpointed',
      output: `${result.output}\nCheckpoint ${checkpoint.stateLabel}: ${checkpoint.result ?? 'no result'}`,
    }
  }

  return {
    ...result,
    checkpoint: null,
    checkpointStatus: 'timeout',
    output: `${result.output}\nNo fresh checkpoint before poll timeout.`,
  }
}

async function waitForFreshCheckpoint(
  workerId: string,
  previousRaw: string | null,
  baselineRuntimeSignature: string,
  dispatchedAt: number,
  timeoutMs: number,
): Promise<ParsedSwarmCheckpoint | null> {
  const started = Date.now()
  const profilePath = getProfilePath(workerId)
  while (Date.now() - started < timeoutMs) {
    const runtimeSnapshot = readRuntimeCheckpointSnapshot(profilePath)
    if (
      runtimeSnapshotIsFresh(
        runtimeSnapshot,
        baselineRuntimeSignature,
        dispatchedAt,
      )
    ) {
      const runtimeCheckpoint = checkpointFromRuntimeSnapshot(runtimeSnapshot)
      // Trust the runtime snapshot when it is fresh (post-dispatch) and the
      // checkpoint content has actually changed.  The runtime checkpointRaw can
      // persist across assignments, so a stale DONE from a previous task would
      // otherwise be returned immediately for a freshly dispatched worker.
      if (runtimeCheckpoint && runtimeCheckpoint.raw !== previousRaw)
        return runtimeCheckpoint
    }

    const chat = readWorkerMessages(profilePath, 50)
    if (chat.ok) {
      // Ignore chat checkpoints produced before this dispatch; otherwise a stale
      // assistant message is mistaken for a fresh response.
      const postDispatchMessages = chat.messages.filter(
        (m) =>
          m.role === 'assistant' &&
          typeof m.timestamp === 'number' &&
          m.timestamp * 1000 >= dispatchedAt - 5_000,
      )
      const checkpoint = newestCheckpointFromMessages(postDispatchMessages)
      if (checkpoint && checkpoint.raw !== previousRaw) return checkpoint
    }
    await sleep(2_000)
  }
  return null
}

function resolveWorkerCwd(workerId: string): string {
  const wrapperPath = getWrapperPath(workerId)
  if (existsSync(wrapperPath)) {
    try {
      const text = readFileSync(wrapperPath, 'utf8')
      const m = text.match(/cd\s+([^\n]+?)\s+\|\|\s+exit\s+1/)
      if (m?.[1]) {
        const raw = m[1].trim().replace(/^['"]|['"]$/g, '')
        if (raw && existsSync(raw)) return raw
      }
    } catch {
      /* noop */
    }
  }
  return homedir()
}

async function captureTmuxPane(
  tmuxBin: string,
  sessionName: string,
): Promise<string> {
  const captured = await execFileAsync(
    tmuxBin,
    ['capture-pane', '-p', '-t', sessionName, '-S', '-200'],
    8_000,
  )
  return captured.ok ? captured.stdout.trim() : ''
}

export async function tmuxSessionHasHermesTui(
  tmuxBin: string,
  sessionName: string,
): Promise<boolean> {
  const pane = await captureTmuxPane(tmuxBin, sessionName)
  return tmuxPaneLooksLikeHermesTui(pane)
}

async function waitForHermesTuiReady(
  tmuxBin: string,
  sessionName: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tmuxSessionHasHermesTui(tmuxBin, sessionName)) {
      return true
    }
    await sleep(500)
  }
  return false
}

async function getPaneCurrentCommand(
  tmuxBin: string,
  sessionName: string,
): Promise<string> {
  const captured = await execFileAsync(
    tmuxBin,
    ['list-panes', '-t', sessionName, '-F', '#{pane_current_command}'],
    8_000,
  )
  return captured.ok ? captured.stdout.trim().split('\n')[0] || '' : ''
}

export async function tmuxSessionHasShellReady(
  tmuxBin: string,
  sessionName: string,
): Promise<boolean> {
  const pane = await captureTmuxPane(tmuxBin, sessionName)
  const paneCommand = await getPaneCurrentCommand(tmuxBin, sessionName)
  return tmuxPaneLooksLikeShellReady(pane, paneCommand)
}

async function waitForShellReady(
  tmuxBin: string,
  sessionName: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tmuxSessionHasShellReady(tmuxBin, sessionName)) {
      return true
    }
    await sleep(500)
  }
  return false
}

async function startHermesTmuxSession(input: {
  tmuxBin: string
  sessionName: string
  profilePath: string
  cwd: string
  hermesBin: string
  ghToken: string | null
  transport: TmuxTransportMode
  workerId: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const execCommand =
    input.transport === 'cli'
      ? buildHermesTmuxShellCommand({
          profilePath: input.profilePath,
          hermesBin: input.hermesBin,
          ghToken: input.ghToken,
        })
      : buildHermesTmuxTuiCommand({
          profilePath: input.profilePath,
          hermesBin: input.hermesBin,
          ghToken: input.ghToken,
          useExec: true,
        })
  const started = await execFileAsync(input.tmuxBin, [
    'new-session',
    '-d',
    '-s',
    input.sessionName,
    '-c',
    input.cwd,
    execCommand,
  ])
  if (!started.ok) {
    return { ok: false, error: started.error }
  }

  await sleep(1_500)
  if (!(await tmuxHasSession(input.tmuxBin, input.sessionName))) {
    return {
      ok: false,
      error: `Hermes worker tmux session ${input.sessionName} exited during startup`,
    }
  }

  const ready =
    input.transport === 'cli'
      ? await waitForShellReady(input.tmuxBin, input.sessionName)
      : await waitForHermesTuiReady(input.tmuxBin, input.sessionName)
  if (!ready) {
    const pane = await captureTmuxPane(input.tmuxBin, input.sessionName)
    const sanitized = redactStartupOutput(pane).slice(-4_000)
    const label = input.transport === 'cli' ? 'shell' : 'Hermes TUI'
    return {
      ok: false,
      error: `${label} did not become ready in ${input.sessionName}. Pane output: ${sanitized}`,
    }
  }

  return { ok: true }
}

function redactStartupOutput(output: string): string {
  return output
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[REDACTED]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]{12,})/g, '[REDACTED]')
}

export async function ensureLiveTmuxSession(
  workerId: string,
  transport: TmuxTransportMode = resolveTmuxTransportMode(),
): Promise<
  | {
      ok: true
      tmuxBin: string
      sessionName: string
      transport: TmuxTransportMode
    }
  | { ok: false; error: string }
> {
  const tmuxBin = resolveTmuxBin()
  if (!tmuxBin) return { ok: false, error: 'tmux not installed' }

  const sessionName = sessionNameFor(workerId)
  const profilePath = getProfilePath(workerId)
  ensureSwarmProfileConfig(profilePath)

  const cwd = resolveWorkerCwd(workerId)
  const hermesBin = resolveHermesBin()
  const ghToken = resolveGithubToken()

  const sessionExists = await tmuxHasSession(tmuxBin, sessionName)
  const sessionUsable =
    sessionExists && (await tmuxSessionUsable(tmuxBin, sessionName))
  const sessionReady =
    sessionUsable &&
    (transport === 'cli'
      ? await tmuxSessionHasShellReady(tmuxBin, sessionName)
      : await tmuxSessionHasHermesTui(tmuxBin, sessionName))

  if (sessionUsable && sessionReady) {
    // sessionReady already verified Hermes TUI / shell markers — do not
    // re-probe and kill here. A second capture can false-negative while the
    // TUI is redrawing and leave dispatch with no pane to paste into.
    return { ok: true, tmuxBin, sessionName, transport }
  }

  if (sessionExists) {
    // Stale shell-only session (Hermes exited) or zombie pane — recreate.
    await tmuxKillSession(tmuxBin, sessionName)
  }

  const started = await startHermesTmuxSession({
    tmuxBin,
    sessionName,
    profilePath,
    cwd,
    hermesBin,
    ghToken,
    transport,
    workerId,
  })
  if (!started.ok) {
    return { ok: false, error: started.error }
  }

  return { ok: true, tmuxBin, sessionName, transport }
}

async function sendPromptToLiveSession(
  workerId: string,
  prompt: string,
): Promise<WorkerResult> {
  const startedAt = Date.now()
  const ensured = await ensureLiveTmuxSession(workerId)
  if (!ensured.ok) {
    // Surface the live-session failure instead of silently falling back to the
    // wrapper. For TUI workers the wrapper fallback usually fails anyway, and
    // hiding the original error makes debugging much harder.
    return {
      workerId,
      ok: false,
      output: '',
      error: `Live tmux session unavailable: ${ensured.error}`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-tui',
    }
  }

  const { tmuxBin, sessionName } = ensured
  if (!(await tmuxSessionHasHermesTui(tmuxBin, sessionName))) {
    return {
      workerId,
      ok: false,
      output: '',
      error: `Session ${sessionName} is not running Hermes TUI (paste would land in shell). Restart the worker session and retry.`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-tui',
    }
  }

  const profilePath = getProfilePath(workerId)
  const taskFilePath = join(profilePath, 'swarm-task.md')
  // Persist the full prompt to disk and deliver a short, single-line instruction
  // to the TUI. Multiline pastes into prompt_toolkit can enter continuation mode
  // and never submit; pointing the agent at a file keeps the pasted input short.
  // The actual paste is additionally wrapped with bracketed-paste sequences so
  // that even the short instruction is accepted as a single paste block.
  try {
    writeFileSync(taskFilePath, prompt, 'utf8')
  } catch (err) {
    return {
      workerId,
      ok: false,
      output: '',
      error: `Failed to write task file ${taskFilePath}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-tui',
    }
  }
  const instruction = `Execute the task in ${taskFilePath} and return the required checkpoint format.`
  const paneTarget = tmuxPaneTarget(sessionName)

  // Do NOT send Ctrl-C here. Hermes prompt_toolkit treats C-c as exit, which
  // tears down the TUI and yields "can't find pane: swarm-<id>" on paste.
  // Bracketed paste replaces the prompt content as a single block.

  const pasteOnce = async (): Promise<void> => {
    if (!(await tmuxSessionHasPane(tmuxBin, sessionName))) {
      throw new Error(`can't find pane: ${sessionName}`)
    }
    await tmuxPasteWithBracketedPaste(tmuxBin, sessionName, instruction)
  }

  try {
    try {
      await pasteOnce()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/can't find (pane|session|window)/i.test(msg)) throw err
      const restarted = await ensureLiveTmuxSession(workerId)
      if (!restarted.ok)
        throw new Error(`${msg}; recreate failed: ${restarted.error}`)
      await pasteOnce()
    }
  } catch (err) {
    return {
      workerId,
      ok: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-tui',
    }
  }

  // Give the TUI enough time to ingest the paste before submitting. With
  // bracketed-paste the content is accepted as a single block, so we only need
  // a short settle before sending Enter.
  await sleep(500)
  const enter = await execFileAsync(tmuxBin, [
    'send-keys',
    '-t',
    paneTarget,
    'C-m',
  ])
  if (!enter.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: enter.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-tui',
    }
  }

  return {
    workerId,
    ok: true,
    output: `Delivered task file ${taskFilePath} to live tmux session ${sessionName}`,
    error: null,
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    delivery: 'tmux-tui',
  }
}

function buildSwarmRunScript(
  profilePath: string,
  hermesBin: string,
  instruction: string,
): string {
  const args = buildHermesChatQueryArgs(instruction)
  const quotedArgs = args.map((arg) => {
    if (/^[a-zA-Z0-9_./:@=-]+$/.test(arg)) return arg
    return `'${shellEscapeSingle(arg)}'`
  })
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export HERMES_HOME='${shellEscapeSingle(profilePath)}'`,
    `export HERMES_CLI_BIN='${shellEscapeSingle(hermesBin)}'`,
    `exec '${shellEscapeSingle(hermesBin)}' ${quotedArgs.join(' ')}`,
    '',
  ].join('\n')
}

async function sendPromptToCliSession(
  workerId: string,
  prompt: string,
): Promise<WorkerResult> {
  const startedAt = Date.now()
  const ensured = await ensureLiveTmuxSession(workerId, 'cli')
  if (!ensured.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: `Live tmux CLI session unavailable: ${ensured.error}`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-cli',
    }
  }

  const { tmuxBin, sessionName } = ensured
  const profilePath = getProfilePath(workerId)
  const taskFilePath = join(profilePath, 'swarm-task.md')
  const runScriptPath = join(profilePath, 'swarm-run.sh')

  try {
    writeFileSync(taskFilePath, prompt, 'utf8')
  } catch (err) {
    return {
      workerId,
      ok: false,
      output: '',
      error: `Failed to write task file ${taskFilePath}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-cli',
    }
  }

  const instruction = `Execute the task in ${taskFilePath} and return the required checkpoint format.`
  const hermesBin = resolveHermesBin()
  try {
    writeFileSync(
      runScriptPath,
      buildSwarmRunScript(profilePath, hermesBin, instruction),
      'utf8',
    )
  } catch (err) {
    return {
      workerId,
      ok: false,
      output: '',
      error: `Failed to write run script ${runScriptPath}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-cli',
    }
  }

  const shellReady = await waitForShellReady(tmuxBin, sessionName, 30_000)
  if (!shellReady) {
    return {
      workerId,
      ok: false,
      output: '',
      error: `Session ${sessionName} shell is busy or not ready for CLI dispatch`,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-cli',
    }
  }

  const dispatchCmd = `bash '${runScriptPath.replace(/'/g, `'\\''`)}'`
  const sent = await execFileAsync(tmuxBin, [
    'send-keys',
    '-t',
    sessionName,
    dispatchCmd,
  ])
  if (!sent.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: sent.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-cli',
    }
  }
  await sleep(150)
  const enter = await execFileAsync(tmuxBin, [
    'send-keys',
    '-t',
    sessionName,
    'C-m',
  ])
  if (!enter.ok) {
    return {
      workerId,
      ok: false,
      output: '',
      error: enter.error,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      delivery: 'tmux-cli',
    }
  }

  return {
    workerId,
    ok: true,
    output: `Dispatched CLI task via ${runScriptPath} in tmux session ${sessionName}`,
    error: null,
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    delivery: 'tmux-cli',
  }
}

function runWorker(
  assignment: AssignmentRequest,
  timeoutMs: number,
  roster: SwarmRosterWorker | undefined,
  options?: {
    waitForCheckpoint?: boolean
    checkpointPollMs?: number
    missionId?: string | null
    notifySessionKey?: string | null
    deliveryMode?: SwarmDeliveryModeRequest
  },
): Promise<WorkerResult> {
  return new Promise(async (resolve) => {
    const workerId = assignment.workerId
    const prompt = buildWorkerPrompt({
      workerId,
      task: assignment.task,
      rationale: assignment.rationale,
      roster,
      direct: assignment.direct,
      missionId: options?.missionId ?? null,
      taskTitle: assignment.task.slice(0, 120),
    })
    const profilePath = getProfilePath(workerId)
    const runtimeBeforeDispatch = readRuntimeCheckpointSnapshot(profilePath)
    // Use the worker's chat history as the authoritative previous checkpoint
    // so waitForFreshCheckpoint does not confuse a stale runtime snapshot with
    // a newly produced checkpoint.
    const chatBeforeDispatch = readWorkerMessages(profilePath, 40)
    const previousChatCheckpoint = chatBeforeDispatch.ok
      ? newestCheckpointFromMessages(chatBeforeDispatch.messages)
      : null
    const previousRaw =
      previousChatCheckpoint?.raw ?? runtimeBeforeDispatch.checkpointRaw
    const baselineRuntimeSignature = runtimeCheckpointSignature(
      runtimeBeforeDispatch,
    )
    markDispatchStarted(
      workerId,
      assignment.task,
      options?.missionId ?? null,
      assignment.assignmentId ?? null,
      options?.notifySessionKey ?? 'main',
    )
    if (options?.missionId) {
      markMissionAssignmentDispatched({
        missionId: options.missionId,
        workerId,
        task: assignment.task,
        source: 'swarm-dispatch',
        author: 'aurora',
      })
    }
    const { mode: deliveryMode, fallback: deliveryFallback } =
      resolveDeliveryMode(options?.deliveryMode)
    appendSwarmMemoryEvent({
      workerId,
      missionId: options?.missionId ?? null,
      assignmentId: assignment.assignmentId ?? null,
      type: 'dispatch',
      summary: `Dispatched task: ${assignment.task.slice(0, 240)}`,
      event: {
        task: assignment.task,
        rationale: assignment.rationale ?? null,
        direct: assignment.direct ?? false,
        deliveryTarget: deliveryMode,
        deliveryFallback,
      },
    })
    const startedAt = Date.now()
    const wrapperPath = getWrapperPath(workerId)
    const checkpointContext: CheckpointDispatchContext = {
      workerId,
      assignment,
      missionId: options?.missionId ?? null,
      notifySessionKey: options?.notifySessionKey ?? 'main',
      previousRaw,
      baselineRuntimeSignature,
      dispatchedAt: startedAt,
      checkpointPollMs: options?.checkpointPollMs ?? 90_000,
    }

    // tmux: persistent session — tmux-tui paste or tmux-cli send-keys.
    // oneshot is used only when tmux is unavailable or explicitly forced.
    if (deliveryMode === 'tmux-tui') {
      const liveResult = await sendPromptToLiveSession(workerId, prompt)
      const result: WorkerResult = { ...liveResult, deliveryFallback }
      markDispatchResult(workerId, result)
      if (!result.ok) {
        recordDispatchBlock(workerId, assignment, result, options)
        resolve(result)
        return
      }
      if (options?.waitForCheckpoint) {
        const withCheckpoint = await attachCheckpointToResult(
          result,
          checkpointContext,
          null,
        )
        recordDispatchBlock(workerId, assignment, withCheckpoint, options)
        resolve(withCheckpoint)
        return
      }
      result.checkpointStatus = 'not-requested'
      recordDispatchBlock(workerId, assignment, result, options)
      resolve(result)
      return
    }

    if (deliveryMode === 'tmux-cli') {
      const liveResult = await sendPromptToCliSession(workerId, prompt)
      const result: WorkerResult = { ...liveResult, deliveryFallback }
      markDispatchResult(workerId, result)
      if (!result.ok) {
        recordDispatchBlock(workerId, assignment, result, options)
        resolve(result)
        return
      }
      if (options?.waitForCheckpoint) {
        const withCheckpoint = await attachCheckpointToResult(
          result,
          checkpointContext,
          null,
        )
        recordDispatchBlock(workerId, assignment, withCheckpoint, options)
        resolve(withCheckpoint)
        return
      }
      result.checkpointStatus = 'not-requested'
      recordDispatchBlock(workerId, assignment, result, options)
      resolve(result)
      return
    }

    if (!existsSync(profilePath)) {
      const result: WorkerResult = {
        workerId,
        ok: false,
        output: '',
        error: `Profile not found at ${profilePath}`,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        delivery: 'oneshot',
        deliveryFallback,
      }
      markDispatchResult(workerId, result)
      recordDispatchBlock(workerId, assignment, result, options)
      resolve(result)
      return
    }

    const useWrapper = existsSync(wrapperPath)
    const cmd = useWrapper ? wrapperPath : resolveHermesBin()
    const args = buildHermesChatQueryArgs(prompt)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_HOME: profilePath,
    }
    const ghToken = resolveGithubToken()
    if (ghToken) {
      env.GH_TOKEN = ghToken
      env.GITHUB_TOKEN = ghToken
    }

    const proc = execFile(
      cmd,
      args,
      {
        env,
        cwd: homedir(),
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_CHARS,
        killSignal: 'SIGTERM',
      },
      (error, stdout, stderr) => {
        void (async () => {
          const durationMs = Date.now() - startedAt
          const stdoutStr = (stdout || '').toString()
          const stderrStr = (stderr || '').toString()
          const out =
            stdoutStr.length > MAX_OUTPUT_CHARS
              ? stdoutStr.slice(-MAX_OUTPUT_CHARS)
              : stdoutStr

          if (error) {
            const code = (error as { code?: number | null }).code ?? null
            const result: WorkerResult = {
              workerId,
              ok: false,
              output: out,
              error: stderrStr.trim() || error.message,
              durationMs,
              exitCode: typeof code === 'number' ? code : null,
              delivery: 'oneshot',
              deliveryFallback,
            }
            markDispatchResult(workerId, result)
            recordDispatchBlock(workerId, assignment, result, options)
            resolve(result)
            return
          }

          let result: WorkerResult = {
            workerId,
            ok: true,
            output: out,
            error: stderrStr.trim() || null,
            durationMs,
            exitCode: 0,
            delivery: 'oneshot',
            deliveryFallback,
          }
          if (options?.waitForCheckpoint) {
            const stdoutCheckpoint = parseSwarmCheckpoint(out)
            result = await attachCheckpointToResult(
              result,
              checkpointContext,
              stdoutCheckpoint,
            )
          } else {
            result.checkpointStatus = 'not-requested'
          }
          markDispatchResult(workerId, result)
          recordDispatchBlock(workerId, assignment, result, options)
          resolve(result)
        })()
      },
    )

    proc.on('error', (error) => {
      const result: WorkerResult = {
        workerId,
        ok: false,
        output: '',
        error: error.message,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        delivery: 'oneshot',
        deliveryFallback,
      }
      markDispatchResult(workerId, result)
      recordDispatchBlock(workerId, assignment, result, options)
      resolve(result)
    })
  })
}

export class SwarmDispatchError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SwarmDispatchError'
    this.status = status
  }
}

export async function dispatchSwarmAssignments(body: DispatchRequest) {
  let assignments = parseAssignments(body.assignments)
  const promptRaw = typeof body.prompt === 'string' ? body.prompt : ''
  const prompt = promptRaw.trim()
  if (assignments.length === 0) {
    const workerIdsRaw = Array.isArray(body.workerIds) ? body.workerIds : []
    const workerIds = workerIdsRaw
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(
        (value) =>
          value.length > 0 &&
          validateWorkerId(value) &&
          isSwarmDispatchWorkerId(value),
      )
    assignments = workerIds.map((workerId) => ({
      workerId,
      task: prompt,
      rationale: 'Legacy broadcast dispatch.',
      direct: body.direct === true,
    }))
  }

  if (assignments.length === 0) {
    throw new SwarmDispatchError('assignments[] or workerIds[] required')
  }
  if (assignments.length > 12) {
    throw new SwarmDispatchError('Maximum 12 workers per dispatch')
  }
  if (assignments.some((assignment) => assignment.task.length === 0)) {
    throw new SwarmDispatchError('assignment task required')
  }
  if (
    assignments.some((assignment) => assignment.task.length > MAX_PROMPT_CHARS)
  ) {
    throw new SwarmDispatchError(
      `assignment task exceeds ${MAX_PROMPT_CHARS} characters`,
    )
  }

  const timeoutRaw =
    typeof body.timeoutSeconds === 'number'
      ? body.timeoutSeconds
      : DEFAULT_TIMEOUT_S
  const timeoutSeconds = Math.max(
    10,
    Math.min(MAX_TIMEOUT_S, Math.floor(timeoutRaw)),
  )
  const timeoutMs = timeoutSeconds * 1000
  const waitForCheckpoint = resolveWaitForCheckpoint(body)
  const pollRaw =
    typeof body.checkpointPollSeconds === 'number'
      ? body.checkpointPollSeconds
      : 90
  const checkpointPollSeconds = Math.max(5, Math.min(300, Math.floor(pollRaw)))
  const notifySessionKey =
    typeof body.notifySessionKey === 'string' && body.notifySessionKey.trim()
      ? body.notifySessionKey.trim()
      : 'main'
  const deliveryMode = parseDeliveryModeRequest(body.deliveryMode)

  const requestedMissionId =
    typeof body.missionId === 'string' ? body.missionId.trim() : ''
  const hasExplicitMissionTitle =
    typeof body.missionTitle === 'string' && body.missionTitle.trim()
  const firstTaskText = assignments[0]?.task?.trim() ?? ''
  const missionTitle = hasExplicitMissionTitle
    ? (body.missionTitle as string).trim()
    : requestedMissionId
      ? ''
      : firstTaskText
        ? firstTaskText.slice(0, 120)
        : `${assignments.length} assigned tasks`
  const mission = createOrUpdateMission({
    missionId: requestedMissionId || null,
    title: missionTitle,
    assignments,
  })
  if (mission._created) {
    for (const workerId of new Set(assignments.map((a) => a.workerId))) {
      try {
        appendSwarmMemoryEvent({
          workerId,
          missionId: mission.id,
          type: 'mission-start',
          title: mission.title,
          summary: `Mission started: ${mission.title}`,
          event: { workers: [...new Set(assignments.map((a) => a.workerId))] },
        })
      } catch {}
    }
  }

  // Mission Control lists from swarm-missions.

  const assignmentIdByKey = new Map(
    mission.assignments.map((item) => [
      `${item.workerId}\n${item.task}`,
      item.id,
    ]),
  )
  assignments = assignments.map((assignment) => ({
    ...assignment,
    assignmentId: assignmentIdByKey.get(
      `${assignment.workerId}\n${assignment.task}`,
    ),
  }))

  const dispatchedAt = Date.now()
  const roster = rosterByWorkerId(
    assignments.map((assignment) => assignment.workerId),
  )
  const results = await Promise.all(
    assignments.map((assignment) =>
      runWorker(assignment, timeoutMs, roster.get(assignment.workerId), {
        waitForCheckpoint,
        checkpointPollMs: checkpointPollSeconds * 1000,
        missionId: mission.id,
        notifySessionKey,
        deliveryMode,
      }),
    ),
  )

  const latestMission = getSwarmMission(mission.id) ?? mission

  if (!waitForCheckpoint) {
    try {
      await harvestSwarmWorkers(
        [...new Set(assignments.map((assignment) => assignment.workerId))],
        'swarm-dispatch-harvest',
      )
    } catch (error) {
      console.error(
        '[swarm-dispatch] post-dispatch harvest failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return {
    dispatchedAt,
    completedAt: Date.now(),
    missionId: mission.id,
    mission: latestMission,
    prompt:
      assignments.length === 1
        ? assignments[0].task
        : `${assignments.length} assigned tasks`,
    assignments,
    timeoutSeconds,
    waitForCheckpoint,
    checkpointPollSeconds,
    notifySessionKey,
    results,
  }
}

export const Route = createFileRoute('/api/swarm-dispatch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: DispatchRequest
        try {
          body = (await request.json()) as DispatchRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        try {
          return json(await dispatchSwarmAssignments(body))
        } catch (error) {
          if (error instanceof SwarmDispatchError) {
            return json({ error: error.message }, { status: error.status })
          }
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      },
    },
  },
})
