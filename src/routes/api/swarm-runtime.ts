import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { getProfilesDir } from '../../server/hermes-paths'
import {
  buildSwarmDispatchMetadata,
  buildSwarmSessionMetadata,
  getSwarmTmuxSessionName,
  getSwarmWrapperPath,
  listSwarmWorkerIds,
  readSwarmRuntimeFile,
} from '../../server/swarm-foundation'
import {
  formatSwarmWorkerLabel,
  resolveSwarmWorkerDisplayName,
  rosterByWorkerId,
} from '../../server/swarm-roster'
import { readSwarmMode, writeSwarmMode } from '../../server/swarm-mode'
import type {
  SwarmArtifactMetadata,
  SwarmBoundary,
  SwarmCheckpointStatus,
  SwarmDispatchMetadata,
  SwarmLifecycleMetadata,
  SwarmPreviewMetadata,
  SwarmRuntimeSource,
  SwarmSessionMetadata,
  SwarmTaskMetadata,
  SwarmTerminalKind,
  SwarmWorkerState,
} from '../../server/swarm-foundation'

type RuntimeEntry = {
  workerId: string
  displayName: string
  humanLabel: string
  role: string
  specialty: string | null
  mission: string | null
  missionId: string | null
  skills: Array<string>
  capabilities: Array<string>
  source: SwarmRuntimeSource
  pid: number | null
  startedAt: number | null
  lastOutputAt: number | null
  cwd: string | null
  currentTask: string | null
  activeTool: string | null
  state: SwarmWorkerState
  phase: string
  checkpointStatus: SwarmCheckpointStatus
  needsHuman: boolean
  blockedReason: string | null
  lastCheckIn: string | null
  lastSummary: string | null
  nextAction: string | null
  lastResult: string | null
  assignedTaskCount: number
  cronJobCount: number
  tmuxSession: string | null
  tmuxAttachable: boolean
  recentLogTail: string | null
  lastSessionStartedAt: number | null
  logPath: string | null
  terminalKind: SwarmTerminalKind
  profilePath: string
  wrapperPath: string | null
  boundary: SwarmBoundary
  lifecycle: SwarmLifecycleMetadata
  session: SwarmSessionMetadata
  dispatch: SwarmDispatchMetadata
  tasks: Array<SwarmTaskMetadata>
  artifacts: Array<SwarmArtifactMetadata>
  previews: Array<SwarmPreviewMetadata>
}

function listWorkerIds(): Array<string> {
  return listSwarmWorkerIds({ swarmOnly: true }).filter(
    (id) => id !== 'workspace',
  )
}

function lastLogTail(
  profilePath: string,
  maxBytes = 4_000,
): {
  tail: string | null
  lastSessionStartedAt: number | null
  logPath: string | null
} {
  const log = join(profilePath, 'logs', 'agent.log')
  if (!existsSync(log))
    return { tail: null, lastSessionStartedAt: null, logPath: null }
  try {
    const stat = statSync(log)
    const buffer = readFileSync(log, 'utf-8')
    const tail = buffer.length > maxBytes ? buffer.slice(-maxBytes) : buffer
    const lines = tail.split('\n')
    const tailLines = lines.slice(-12).join('\n')
    return { tail: tailLines, lastSessionStartedAt: stat.mtimeMs, logPath: log }
  } catch {
    return { tail: null, lastSessionStartedAt: null, logPath: null }
  }
}

function resolveTmuxBin(): string {
  const override = process.env.HERMES_TMUX_BIN || process.env.CLAUDE_TMUX_BIN
  if (override) return override
  const local = join(homedir(), '.local', 'bin', 'tmux')
  return existsSync(local) ? local : 'tmux'
}

function tmuxHasSession(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      resolveTmuxBin(),
      ['has-session', '-t', name],
      (error) => resolve(!error),
    )
    // Bail out quickly if tmux is unresponsive — avoids blocking the runtime poll.
    setTimeout(() => {
      resolve(false)
      try {
        child.kill()
      } catch {}
    }, 2000)
  })
}

/** Return the current foreground command in the first pane of a tmux session. */
function tmuxPaneCommand(sessionName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      resolveTmuxBin(),
      [
        'display-message',
        '-p',
        '-t',
        `${sessionName}:0`,
        '#{pane_current_command}',
      ],
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    )
    setTimeout(() => {
      resolve(null)
      try {
        child.kill()
      } catch {}
    }, 2000)
  })
}

/** Capture the last N lines of tmux pane content to check for TUI readiness. */
function tmuxCapturePane(sessionName: string, lines = 6): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      resolveTmuxBin(),
      ['capture-pane', '-p', '-t', `${sessionName}:0`, '-S', `-${lines}`],
      (error, stdout) => resolve(error ? '' : stdout.toString().trim()),
    )
    setTimeout(() => {
      resolve('')
      try {
        child.kill()
      } catch {}
    }, 2000)
  })
}

function tmuxIsInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(resolveTmuxBin(), ['-V'], (error) => resolve(!error))
    setTimeout(() => {
      resolve(false)
      try {
        child.kill()
      } catch {}
    }, 2000)
  })
}

async function probeTmuxName(
  workerId: string,
  hint: string | null,
): Promise<string | null> {
  const candidates = [
    hint,
    getSwarmTmuxSessionName(workerId),
    workerId,
    `hermes-${workerId}`,
    `agent-${workerId}`,
  ].filter((value): value is string => Boolean(value))
  const seen = new Set<string>()
  const unique = candidates.filter((c) => {
    if (seen.has(c)) return false
    seen.add(c)
    return true
  })
  // Probe all candidates in parallel instead of sequentially to avoid stacking
  // multiple serial tmux calls per worker (which causes 30s+ GET /api/swarm-runtime).
  const results = await Promise.all(
    unique.map(async (c) => ((await tmuxHasSession(c)) ? c : null)),
  )
  return results.find((r) => r !== null) ?? null
}

async function buildEntry(
  workerId: string,
  tmuxAvailable: boolean,
): Promise<RuntimeEntry> {
  const profilePath = join(getProfilesDir(), workerId)
  const { source, runtime } = readSwarmRuntimeFile(profilePath, workerId, {
    workspaceRoot: process.cwd(),
  })
  const roster = rosterByWorkerId([workerId]).get(workerId)
  const { tail, lastSessionStartedAt, logPath } = lastLogTail(profilePath)
  const matched = tmuxAvailable
    ? await probeTmuxName(workerId, getSwarmTmuxSessionName(workerId))
    : null
  const tmuxAttachable = Boolean(matched)

  // Detect zombie executing state: runtime says executing but the tmux pane
  // has returned to shell (hermes process exited without writing a final checkpoint).
  // Grace period: 2 minutes after dispatch to allow slow startup.
  const EXECUTING_GRACE_MS = 2 * 60_000
  const lastDispatchAt =
    typeof runtime.lastDispatchAt === 'number' ? runtime.lastDispatchAt : 0
  const dispatchAge = Date.now() - lastDispatchAt
  let effectiveState = runtime.state
  let effectiveCheckpointStatus = runtime.checkpointStatus
  let effectiveBlockedReason = runtime.blockedReason
  if (
    runtime.state === 'executing' &&
    matched &&
    dispatchAge > EXECUTING_GRACE_MS
  ) {
    const paneCmd = await tmuxPaneCommand(matched)
    // If pane is at shell prompt (bash/zsh/sh) the worker process has exited.
    const shellNames = new Set(['bash', 'zsh', 'sh', 'fish', 'dash'])
    if (paneCmd && shellNames.has(paneCmd)) {
      effectiveState = 'blocked'
      effectiveCheckpointStatus = 'blocked'
      effectiveBlockedReason = `Process exited without checkpoint (pane returned to ${paneCmd})`
    } else {
      // TUI process is still alive — check if it's actually at a ready
      // prompt (finished the task but never wrote a DONE checkpoint).
      // This happens with simple tasks like ping that return immediately.
      const paneText = await tmuxCapturePane(matched, 8)
      if (paneText.includes('❯') && paneText.includes('ready')) {
        effectiveState = 'idle'
        effectiveCheckpointStatus = 'done'
      }
    }
  }
  let terminalKind: SwarmTerminalKind = 'none'
  if (tmuxAttachable) terminalKind = 'tmux'
  else if (runtime.cwd) terminalKind = 'shell'
  else if (logPath) terminalKind = 'log-tail'

  const wrapperPath = getSwarmWrapperPath(workerId)
  const resolvedWrapperPath = existsSync(wrapperPath) ? wrapperPath : null
  const session = buildSwarmSessionMetadata({
    workerId,
    profilePath,
    runtime,
    tmuxSession: matched,
    terminalKind,
    recentLogTail: tail,
    lastSessionStartedAt,
    logPath,
  })
  const dispatch = buildSwarmDispatchMetadata({
    runtime,
    tmuxAttachable,
    wrapperExists: Boolean(resolvedWrapperPath),
  })
  const lifecycle: SwarmLifecycleMetadata = {
    state: effectiveState,
    phase: runtime.phase,
    checkpointStatus: effectiveCheckpointStatus,
    needsHuman: runtime.needsHuman,
    blockedReason: effectiveBlockedReason,
    startedAt: runtime.startedAt,
    lastOutputAt: runtime.lastOutputAt,
    lastCheckIn: runtime.lastCheckIn,
    lastSummary: runtime.lastSummary,
    lastResult: runtime.lastResult,
    nextAction: runtime.nextAction,
    pid: readPid(profilePath),
    tmuxSession: matched,
    tmuxAttachable,
    terminalKind,
  }

  return {
    workerId,
    displayName: resolveSwarmWorkerDisplayName(workerId, roster),
    humanLabel: formatSwarmWorkerLabel(workerId, roster),
    role: roster?.role || runtime.role,
    specialty: roster?.specialty || null,
    mission: roster?.mission || null,
    missionId: runtime.missionId || null,
    skills: roster?.skills?.length ? roster.skills : [],
    capabilities: roster?.capabilities?.length ? roster.capabilities : [],
    source,
    pid: lifecycle.pid,
    startedAt: runtime.startedAt,
    lastOutputAt: runtime.lastOutputAt,
    cwd: runtime.cwd,
    currentTask: runtime.currentTask,
    activeTool: runtime.activeTool,
    state: effectiveState,
    phase: runtime.phase,
    checkpointStatus: effectiveCheckpointStatus,
    needsHuman: runtime.needsHuman,
    blockedReason: effectiveBlockedReason,
    lastCheckIn: runtime.lastCheckIn,
    lastSummary: runtime.lastSummary,
    nextAction: runtime.nextAction,
    lastResult: runtime.lastResult,
    assignedTaskCount: runtime.assignedTaskCount,
    cronJobCount: runtime.cronJobCount,
    tmuxSession: matched,
    tmuxAttachable,
    recentLogTail: tail,
    lastSessionStartedAt,
    logPath,
    terminalKind,
    profilePath,
    wrapperPath: resolvedWrapperPath,
    boundary: runtime.boundary,
    lifecycle,
    session,
    dispatch,
    tasks: runtime.tasks,
    artifacts: runtime.artifacts,
    previews: runtime.previews,
  }
}

function readPid(profilePath: string): number | null {
  const runtimePath = join(profilePath, 'runtime.json')
  if (!existsSync(runtimePath)) return null
  try {
    const raw = JSON.parse(readFileSync(runtimePath, 'utf-8')) as Record<
      string,
      unknown
    >
    return typeof raw.pid === 'number' ? raw.pid : null
  } catch {
    return null
  }
}

export const Route = createFileRoute('/api/swarm-runtime')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ids = listWorkerIds()
        const tmuxAvailable = await tmuxIsInstalled()
        const entries = await Promise.all(
          ids.map((id) => buildEntry(id, tmuxAvailable)),
        )
        return json({
          checkedAt: Date.now(),
          registryVersion: 1,
          workspaceRoot: process.cwd(),
          tmuxAvailable,
          entries,
          mode: readSwarmMode(),
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        let body: { mode?: unknown }
        try {
          body = (await request.json()) as { mode?: unknown }
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        if (body.mode !== 'auto' && body.mode !== 'manual') {
          return json({ error: 'mode must be auto or manual' }, { status: 400 })
        }
        return json({ ok: true, mode: writeSwarmMode(body.mode) })
      },
    },
  },
})
