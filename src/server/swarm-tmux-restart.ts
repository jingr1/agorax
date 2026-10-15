import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ensureLiveTmuxSession,
  resolveTmuxBin,
} from '../routes/api/swarm-dispatch'
import { getSwarmProfilePath, patchSwarmRuntimeFile } from './swarm-foundation'

const execFileAsync = promisify(execFile)
const SWARM_SESSION_PREFIX = 'swarm-'

export type SwarmWorkerRestartResult = {
  workerId: string
  wasRunning: boolean
  stopped: boolean
  started: boolean
  error?: string
}

export type RestartActiveSwarmWorkersResult = {
  workerIds: Array<string>
  results: Array<SwarmWorkerRestartResult>
}

export function workerIdFromSwarmSessionName(
  sessionName: string,
): string | null {
  if (!sessionName.startsWith(SWARM_SESSION_PREFIX)) return null
  const workerId = sessionName.slice(SWARM_SESSION_PREFIX.length)
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workerId) ? workerId : null
}

export async function listActiveSwarmWorkerIds(): Promise<Array<string>> {
  const tmuxBin = resolveTmuxBin()
  if (!tmuxBin) return []
  try {
    const { stdout } = await execFileAsync(
      tmuxBin,
      ['list-sessions', '-F', '#{session_name}'],
      { timeout: 5_000 },
    )
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .map((name) => workerIdFromSwarmSessionName(name))
      .filter((workerId): workerId is string => Boolean(workerId))
      .sort()
  } catch {
    return []
  }
}

async function tmuxHasSession(
  tmuxBin: string,
  sessionName: string,
): Promise<boolean> {
  try {
    await execFileAsync(tmuxBin, ['has-session', '-t', sessionName], {
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}

export async function stopSwarmWorkerTmux(
  workerId: string,
): Promise<{ ok: boolean; wasRunning: boolean; error?: string }> {
  const tmuxBin = resolveTmuxBin()
  if (!tmuxBin) {
    return {
      ok: false,
      wasRunning: false,
      error: 'tmux not installed on this host',
    }
  }

  const sessionName = `${SWARM_SESSION_PREFIX}${workerId}`
  const wasRunning = await tmuxHasSession(tmuxBin, sessionName)
  if (!wasRunning) {
    return { ok: true, wasRunning: false }
  }

  try {
    await execFileAsync(tmuxBin, ['kill-session', '-t', sessionName], {
      timeout: 5_000,
    })
  } catch (error) {
    return {
      ok: false,
      wasRunning: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const profilePath = getSwarmProfilePath(workerId)
  const stoppedAt = Date.now()
  patchSwarmRuntimeFile(profilePath, workerId, {
    state: 'idle',
    phase: 'stopped',
    currentTask: null,
    activeTool: null,
    needsHuman: false,
    blockedReason: null,
    checkpointStatus: 'none',
    lastDispatchResult: 'Stopped for Hermes Agent update reload',
    lastOutputAt: stoppedAt,
    checkpointRaw: null,
    orchestratorProcessedRaw: null,
  })

  return { ok: true, wasRunning: true }
}

export async function restartSwarmWorkerTmux(
  workerId: string,
): Promise<SwarmWorkerRestartResult> {
  const stopped = await stopSwarmWorkerTmux(workerId)
  if (!stopped.ok) {
    return {
      workerId,
      wasRunning: stopped.wasRunning,
      stopped: false,
      started: false,
      error: stopped.error,
    }
  }

  // Brief pause so tmux releases the session name before recreate.
  await new Promise((resolve) => setTimeout(resolve, 400))

  const started = await ensureLiveTmuxSession(workerId)
  return {
    workerId,
    wasRunning: stopped.wasRunning,
    stopped: stopped.wasRunning,
    started: started.ok,
    error: started.ok ? undefined : started.error,
  }
}

export async function restartActiveSwarmWorkers(
  input: { workerIds?: Array<string> } = {},
): Promise<RestartActiveSwarmWorkersResult> {
  const workerIds = input.workerIds?.length
    ? [...new Set(input.workerIds)]
    : await listActiveSwarmWorkerIds()

  const results: Array<SwarmWorkerRestartResult> = []
  for (const workerId of workerIds) {
    results.push(await restartSwarmWorkerTmux(workerId))
  }
  return { workerIds, results }
}

export function formatSwarmWorkerRestartSummary(
  result: RestartActiveSwarmWorkersResult,
): string {
  if (!result.workerIds.length) {
    return 'No active swarm tmux sessions to restart.'
  }
  const lines = result.results.map((item) => {
    if (item.started) {
      return `✓ ${item.workerId}: restarted`
    }
    if (!item.wasRunning) {
      return `- ${item.workerId}: not running (skipped)`
    }
    return `✗ ${item.workerId}: ${item.error ?? 'restart failed'}`
  })
  return ['Restarted swarm workers after Hermes Agent update:', ...lines].join(
    '\n',
  )
}
