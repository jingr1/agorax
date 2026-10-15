/**
 * Remote terminal workspace resolution (SSH, Docker, Modal, etc.).
 *
 * When terminal.backend is not "local", workspace paths live on the target
 * machine — not on the Workspace host. Local stat() must not gate workspace
 * selection or `[Workspace::v1: …]` injection.
 */
import path from 'node:path'
import { isBlockedSystemPath } from './workspace-path-policy'
import { getActiveProfileName, readProfile } from './profiles-browser'

export type TerminalConfig = Record<string, unknown>

const LOCAL_TERMINAL_BACKENDS = new Set(['', 'local'])

export function isRemoteTerminalBackend(terminalCfg: unknown): boolean {
  if (
    !terminalCfg ||
    typeof terminalCfg !== 'object' ||
    Array.isArray(terminalCfg)
  ) {
    return false
  }
  const backend = String((terminalCfg as TerminalConfig).backend ?? '')
    .trim()
    .toLowerCase()
  return !LOCAL_TERMINAL_BACKENDS.has(backend)
}

export function readRemoteTerminalCwd(
  config: Record<string, unknown>,
): string | null {
  const terminal = config.terminal
  if (!isRemoteTerminalBackend(terminal)) return null
  const cwd = String((terminal as TerminalConfig).cwd ?? '').trim()
  // Remote-ness is decided by terminal.backend, not by whether cwd was set.
  // Without an explicit cwd, default to the remote user's home directory.
  return cwd && cwd !== '.' ? cwd : '~'
}

function normalizePosixPath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  return path.posix.normalize(trimmed.replace(/\\/g, '/'))
}

export function isRemotePathUnderCwd(
  candidatePath: string,
  remoteCwd: string,
): boolean {
  const candidate = normalizePosixPath(candidatePath)
  const base = normalizePosixPath(remoteCwd)
  if (!candidate || !base) return false
  if (candidate === base) return true
  const relative = path.posix.relative(base, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.posix.isAbsolute(relative)
  )
}

/**
 * Return a trusted target-side workspace path when it sits under terminal.cwd.
 * Does not stat the local filesystem.
 */
export function remoteTerminalWorkspaceCandidate(
  candidatePath: string,
  remoteCwd: string,
): string | null {
  const normalized = normalizePosixPath(candidatePath)
  const normalizedCwd = normalizePosixPath(remoteCwd)
  if (!normalized || !normalizedCwd) return null
  if (isBlockedSystemPath(normalized) || isBlockedSystemPath(normalizedCwd)) {
    return null
  }
  if (!isRemotePathUnderCwd(normalized, normalizedCwd)) return null
  return normalized
}

function readConfigString(
  config: Record<string, unknown>,
  key: string,
): string {
  return typeof config[key] === 'string' ? config[key].trim() : ''
}

/**
 * Profile default workspace for remote terminal backends.
 * Priority: workspace -> default_workspace -> terminal.cwd
 */
export function profileDefaultRemoteWorkspace(
  config: Record<string, unknown>,
  remoteCwd: string,
): string {
  for (const key of ['workspace', 'default_workspace'] as const) {
    const value = readConfigString(config, key)
    if (!value) continue
    const candidate = remoteTerminalWorkspaceCandidate(value, remoteCwd)
    if (candidate) return candidate
    if (isRemotePathUnderCwd(value, remoteCwd)) {
      return normalizePosixPath(value) ?? value
    }
    // Explicit config key on a remote profile — trust as target-side path.
    return value
  }
  return normalizePosixPath(remoteCwd) ?? remoteCwd
}

export function isValidRemoteWorkspacePath(
  candidatePath: string,
  remoteCwd: string,
): boolean {
  return remoteTerminalWorkspaceCandidate(candidatePath, remoteCwd) !== null
}

export function getActiveProfileConfig(): Record<string, unknown> {
  try {
    const active = getActiveProfileName()
    return readProfile(active).config
  } catch {
    return {}
  }
}

export function getActiveRemoteWorkspaceContext(): {
  backend: string
  remoteCwd: string
  config: Record<string, unknown>
} | null {
  const config = getActiveProfileConfig()
  const terminal = config.terminal
  if (!isRemoteTerminalBackend(terminal)) return null
  const remoteCwd = readRemoteTerminalCwd(config)
  if (!remoteCwd) return null
  const backend = String((terminal as TerminalConfig).backend ?? '')
    .trim()
    .toLowerCase()
  return { backend, remoteCwd, config }
}

export function ensureRemoteWorkspacePath(
  input: string,
  workspaceRoot: string,
): string {
  const raw = input.trim()
  const resolved = !raw
    ? workspaceRoot
    : raw.startsWith('/')
      ? path.posix.normalize(raw)
      : path.posix.normalize(path.posix.join(workspaceRoot, raw))
  const trusted = remoteTerminalWorkspaceCandidate(resolved, workspaceRoot)
  if (!trusted) {
    throw new Error('Path is outside workspace')
  }
  return trusted
}
