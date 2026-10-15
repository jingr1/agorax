import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
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

/**
 * Start the managed-agent daemon when `/health` is down. A healthy daemon is
 * left running.
 */
export async function ensureManagedAgentDaemon(): Promise<{
  ok: boolean
  healthy: boolean
  detail: string
}> {
  const baseUrl = managedAgentBaseUrl() || DEFAULT_DAEMON_URL
  if (await probeManagedAgentDaemonHealth(baseUrl)) {
    return {
      ok: true,
      healthy: true,
      detail: `already healthy at ${baseUrl}`,
    }
  }
  return restartManagedAgentDaemon()
}

/**
 * Force-restart the local Agorax managed-agent daemon on the host network.
 * Prefers the prebuilt `.agorax/agorax-agentd` binary; falls back to
 * `scripts/dev-managed-agent.sh --force` (go run).
 */
export async function restartManagedAgentDaemon(): Promise<{
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
    const child = spawn('bash', [hostScript], {
      cwd: root,
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    launchDetail = `spawned ${hostScript} pid=${child.pid ?? '?'}`
  } else {
    return {
      ok: false,
      healthy: false,
      detail: `neither ${binary} nor ${hostScript} is available`,
    }
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
