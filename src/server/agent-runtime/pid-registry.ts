/**
 * pid registry — maps runId → spawned process group info, persisted to disk
 * so a server restart can re-attach (or reap) detached managed processes.
 *
 * Managed processes are spawned detached:true + unref() (plan «Adapter 实现
 * 要点»), so they survive the server. On boot, the runtime layer calls
 * reconcileRegistry(): entries whose process group is dead are removed;
 * live ones can be re-attached for PTY/stats (P2a reconcile uses this too).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHermesRoot } from '../hermes-paths'

export type PidRegistryEntry = {
  runId: string
  agentId: string
  /** Process group leader pid (the spawned child, detached → pgid = pid). */
  pid: number
  runtime: string
  startedAt: number
  /** Path of the per-run log file capturing stdout/stderr. */
  logPath: string
}

function registryPath(root?: string): string {
  return path.join(root ?? getHermesRoot(), 'agent-pids.json')
}

function readAll(root?: string): Array<PidRegistryEntry> {
  try {
    const raw = fs.readFileSync(registryPath(root), 'utf-8')
    const parsed = JSON.parse(raw) as Array<PidRegistryEntry>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(entries: Array<PidRegistryEntry>, root?: string): void {
  const file = registryPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2))
  fs.renameSync(tmp, file) // atomic rename, same pattern as mission store
}

export function registerPid(entry: PidRegistryEntry, root?: string): void {
  const entries = readAll(root).filter((e) => e.runId !== entry.runId)
  entries.push(entry)
  writeAll(entries, root)
}

export function unregisterPid(runId: string, root?: string): void {
  writeAll(
    readAll(root).filter((e) => e.runId !== runId),
    root,
  )
}

export function lookupPid(
  runId: string,
  root?: string,
): PidRegistryEntry | null {
  return readAll(root).find((e) => e.runId === runId) ?? null
}

export function listPids(root?: string): Array<PidRegistryEntry> {
  return readAll(root)
}

/** Is this process group alive? (pid is the group leader for detached spawns) */
export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

/** Kill the entire process group. Returns true if a signal was delivered. */
export function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Boot-time reconciliation: drop entries whose process group is gone.
 * Returns the survivors (still-alive groups) so the caller can re-attach.
 */
export function reconcileRegistry(root?: string): Array<PidRegistryEntry> {
  const survivors = readAll(root).filter((e) => isProcessGroupAlive(e.pid))
  writeAll(survivors, root)
  return survivors
}
