import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8788'
const HEALTH_POLL_MS = 400
const HEALTH_TIMEOUT_MS = 45_000

function managedAgentBaseUrl(): string {
  return (
    process.env.AGORAX_MANAGED_AGENT_URL?.trim() ||
    `http://127.0.0.1:${process.env.AGORAX_MANAGED_AGENT_PORT?.trim() || '8788'}`
  )
}

export async function probeManagedAgentDaemonHealth(
  baseUrl = managedAgentBaseUrl(),
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, '')}/health`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

function workspaceRoot(): string {
  // routes/api → src/routes/api → … this file lives under src/server/agent-runtime
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  )
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export type ManagedAgentStaleCheckDeps = {
  binaryPath: string
  port: string
  listListenerPids?: (port: string) => Promise<number[]>
  processStartMs?: (pid: number) => Promise<number | null>
  processArgs?: (pid: number) => Promise<string | null>
  exeLink?: (pid: number) => Promise<string | null>
  binaryMtimeMs?: (binaryPath: string) => Promise<number | null>
}

function isAgoraxAgentdArgs(args: string): boolean {
  return (
    args.includes('agorax-agentd') ||
    args.includes('packages/agent/daemon/cmd/agorax-agentd') ||
    args.includes('cmd/agorax-agentd')
  )
}

async function defaultListListenerPids(port: string): Promise<number[]> {
  return await new Promise((resolve) => {
    const child = spawn(
      'bash',
      [
        '-lc',
        [
          `ss -ltnp 2>/dev/null | awk -v p=":${port}" 'index($4,p){while(match($0,/pid=[0-9]+/)){print substr($0,RSTART+4,RLENGTH-4);$0=substr($0,RSTART+RLENGTH)}}' | sort -u`,
        ].join('\n'),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('exit', () => {
      const pids = stdout
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
      resolve([...new Set(pids)])
    })
    child.on('error', () => resolve([]))
  })
}

async function defaultProcessStartMs(pid: number): Promise<number | null> {
  try {
    const info = await stat(`/proc/${pid}`)
    return info.mtimeMs
  } catch {
    return null
  }
}

async function defaultProcessArgs(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn('ps', ['-p', String(pid), '-o', 'args='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('exit', () => resolve(stdout.trim() || null))
    child.on('error', () => resolve(null))
  })
}

async function defaultExeLink(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn('readlink', [`/proc/${pid}/exe`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('exit', () => resolve(stdout.trim() || null))
    child.on('error', () => resolve(null))
  })
}

async function defaultBinaryMtimeMs(
  binaryPath: string,
): Promise<number | null> {
  try {
    const info = await stat(binaryPath)
    return info.mtimeMs
  } catch {
    return null
  }
}

/**
 * True when the preferred on-disk binary is newer than an agorax-agentd
 * listener on the port, the listener was started from another path, or the
 * mapped exe was replaced (`(deleted)`). Detection failures return false so a
 * healthy daemon is not killed when /proc or ss is unavailable.
 */
export async function isManagedAgentDaemonBinaryStale(
  deps: ManagedAgentStaleCheckDeps,
): Promise<boolean> {
  const binaryMtimeMs = await (
    deps.binaryMtimeMs ?? defaultBinaryMtimeMs
  )(deps.binaryPath)
  if (binaryMtimeMs == null) return false

  const listListenerPids = deps.listListenerPids ?? defaultListListenerPids
  const processStartMs = deps.processStartMs ?? defaultProcessStartMs
  const processArgs = deps.processArgs ?? defaultProcessArgs
  const exeLink = deps.exeLink ?? defaultExeLink

  const pids = await listListenerPids(deps.port)
  const binaryReal = path.resolve(deps.binaryPath)

  for (const pid of pids) {
    const args = await processArgs(pid)
    if (!args || !isAgoraxAgentdArgs(args)) continue

    const startedAt = await processStartMs(pid)
    if (startedAt != null && binaryMtimeMs > startedAt) {
      return true
    }

    const exe = args.split(/\s+/)[0] ?? ''
    if (
      exe &&
      exe !== deps.binaryPath &&
      path.resolve(exe) !== binaryReal &&
      exe.includes('agorax-agentd')
    ) {
      return true
    }

    const linked = await exeLink(pid)
    if (linked?.includes('(deleted)')) {
      return true
    }
  }

  return false
}

export type EnsureManagedAgentDaemonDeps = {
  probeHealth?: (baseUrl: string) => Promise<boolean>
  binaryExists?: (binaryPath: string) => Promise<boolean>
  isBinaryStale?: (deps: ManagedAgentStaleCheckDeps) => Promise<boolean>
  restart?: (reason?: string) => Promise<{
    ok: boolean
    healthy: boolean
    detail: string
  }>
}

/**
 * Start the managed-agent daemon when `/health` is down, or replace it when
 * the preferred on-disk binary is newer than the running listener.
 */
export async function ensureManagedAgentDaemon(
  deps: EnsureManagedAgentDaemonDeps = {},
): Promise<{
  ok: boolean
  healthy: boolean
  detail: string
}> {
  const baseUrl = managedAgentBaseUrl() || DEFAULT_DAEMON_URL
  const root = workspaceRoot()
  const binary = path.join(root, '.agorax', 'agorax-agentd')
  const port = process.env.AGORAX_MANAGED_AGENT_PORT?.trim() || '8788'
  const probeHealth = deps.probeHealth ?? probeManagedAgentDaemonHealth
  const binaryExists = deps.binaryExists ?? pathExists
  const isBinaryStale = deps.isBinaryStale ?? isManagedAgentDaemonBinaryStale
  const restart = deps.restart ?? restartManagedAgentDaemon

  if (await probeHealth(baseUrl)) {
    let stale = false
    if (await binaryExists(binary)) {
      stale = await isBinaryStale({
        binaryPath: binary,
        port,
      })
    }
    if (!stale) {
      return {
        ok: true,
        healthy: true,
        detail: `already healthy at ${baseUrl}`,
      }
    }
    return restart(
      `on-disk ${binary} is newer than listener on :${port}`,
    )
  }
  return restart()
}

/**
 * Force-restart the local Agorax managed-agent daemon on the host network.
 * Prefers the prebuilt `.agorax/agorax-agentd` binary; falls back to
 * `scripts/dev-managed-agent.sh --force` (go run).
 */
export async function restartManagedAgentDaemon(
  reason?: string,
): Promise<{
  ok: boolean
  healthy: boolean
  detail: string
}> {
  const root = workspaceRoot()
  const binary = path.join(root, '.agorax', 'agorax-agentd')
  const hostScript = path.join(root, 'scripts', 'start-managed-agent-host.sh')
  const logPath =
    process.env.AGORAX_AGENT_LOG?.trim() || '/tmp/agorax-daemon.log'
  const port = process.env.AGORAX_MANAGED_AGENT_PORT?.trim() || '8788'
  const dbPath =
    process.env.AGORAX_AGENT_DB_PATH?.trim() ||
    path.join(root, '.agorax', 'agent.db')

  // Free a stale listener that no longer answers /health (sandbox orphan etc.).
  await freeStaleManagedAgentPort(port)

  const env = {
    ...process.env,
    AGORAX_MANAGED_AGENT_PORT: port,
    AGORAX_AGENT_DB_PATH: dbPath,
    AGORAX_AGENT_LOG: logPath,
    PATH: [
      `${process.env.HOME || ''}/.local/go1.27.2/bin`,
      `${process.env.HOME || ''}/.local/go1.24.5/bin`,
      `${process.env.HOME || ''}/go/bin`,
      '/usr/local/go/bin',
      process.env.PATH || '',
    ]
      .filter(Boolean)
      .join(path.delimiter),
  }

  let launchDetail: string
  if (await pathExists(binary)) {
    const child = spawn(binary, [], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    launchDetail = `spawned ${binary} pid=${child.pid ?? '?'}`
  } else if (await pathExists(hostScript)) {
    const child = spawn('bash', [hostScript, '--force'], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    launchDetail = `spawned ${hostScript} --force pid=${child.pid ?? '?'}`
  } else {
    return {
      ok: false,
      healthy: false,
      detail: `neither ${binary} nor ${hostScript} is available`,
    }
  }

  if (reason) {
    launchDetail = `${reason}; ${launchDetail}`
  }

  const baseUrl = managedAgentBaseUrl() || DEFAULT_DAEMON_URL
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probeManagedAgentDaemonHealth(baseUrl)) {
      return {
        ok: true,
        healthy: true,
        detail: `${launchDetail}; health ok at ${baseUrl}`,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
  }

  return {
    ok: false,
    healthy: false,
    detail: `${launchDetail}; timed out waiting for ${baseUrl}/health (${HEALTH_TIMEOUT_MS}ms)`,
  }
}

async function freeStaleManagedAgentPort(port: string): Promise<void> {
  // Best-effort: only kill listeners that look like agorax-agentd. Never touch
  // foreign processes holding the port.
  await new Promise<void>((resolve) => {
    const child = spawn(
      'bash',
      [
        '-lc',
        [
          `pids=$(ss -ltnp 2>/dev/null | awk -v p=":${port}" 'index($4,p){while(match($0,/pid=[0-9]+/)){print substr($0,RSTART+4,RLENGTH-4);$0=substr($0,RSTART+RLENGTH)}}' | sort -u)`,
          'for pid in $pids; do',
          '  cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)',
          '  case "$cmd" in',
          '    *agorax-agentd*|*packages/agent/daemon/cmd/agorax-agentd*|*cmd/agorax-agentd*) kill "$pid" 2>/dev/null || true ;;',
          '  esac',
          'done',
          'sleep 0.4',
        ].join('\n'),
      ],
      { stdio: 'ignore' },
    )
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}
