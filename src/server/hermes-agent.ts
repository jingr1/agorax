import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  getActiveProfileName,
  resolveProfileHermesHome,
} from './profiles-browser'
import { profileOwnsPort } from './gateway-port-owner'
import { ensureProfileApiServerEnv } from './gateway-ports'
import { getStateDir } from './workspace-state-dir'

const HERMES_HEALTH_TIMEOUT_MS = 2_000
const HERMES_START_PORT = 8642

let startPromise: Promise<StartHermesAgentResult> | null = null

export type StartHermesAgentResult =
  | {
      ok: true
      message: string
      pid?: number
      profile?: string
      hermesHome?: string
    }
  | {
      ok: false
      error: string
      profile?: string
      hermesHome?: string
    }

type StartGatewayOptions = {
  profileName?: string
  port?: number
  /** When true, replace this profile's gateway only (`hermes gateway run --replace`). */
  forceReplace?: boolean
  /** When false, return as soon as the process is spawned. Default true. */
  waitForHealthy?: boolean
}

/**
 * Read a profile's .env and return key=value pairs as an object.
 * Silently returns {} if the file doesn't exist or can't be parsed.
 */
export function readHermesEnv(hermesHome?: string): Record<string, string> {
  const envPath = join(
    hermesHome ||
      process.env.HERMES_HOME ||
      join(homedir(), '.hermes'),
    '.env',
  )
  try {
    const raw = readFileSync(envPath, 'utf-8')
    const result: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (key) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/** Same directory resolution logic as vite.config.ts. Kept in sync. */
export function resolveHermesAgentDir(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const candidates: Array<string> = []

  const explicitAgentPath = env.HERMES_AGENT_PATH?.trim()
  if (explicitAgentPath) {
    candidates.push(explicitAgentPath)
  }

  const workspaceRoot = dirname(resolve('.'))
  candidates.push(
    resolve(workspaceRoot, 'hermes-agent'),
    resolve(workspaceRoot, '..', 'hermes-agent'),
    resolve(homedir(), '.hermes', 'hermes-agent'),
    resolve(homedir(), 'hermes-agent'),
  )

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'webapi'))) return candidate
  }

  return null
}

/** Find the `hermes`/`claude` CLI binary installed by Nous's installer (or on PATH). */
export function resolveHermesBinary(): string | null {
  const candidates = [
    resolve(homedir(), '.local', 'bin', 'hermes'),
    resolve(homedir(), '.hermes', 'bin', 'hermes'),
    resolve(homedir(), '.claude', 'bin', 'claude'),
    resolve(homedir(), '.local', 'bin', 'claude'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function resolveHermesPython(agentDir: string): string {
  const venvPython = resolve(agentDir, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  const uvVenv = resolve(agentDir, 'venv', 'bin', 'python')
  if (existsSync(uvVenv)) return uvVenv
  const nousPython = resolve(homedir(), '.claude', 'venv', 'bin', 'python')
  if (existsSync(nousPython)) return nousPython
  return 'python3'
}

export async function isHermesAgentHealthy(
  port = HERMES_START_PORT,
  timeoutMs = HERMES_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return false
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/html')) return false
    if (contentType.includes('json')) return true
    const text = await response.text()
    const trimmed = text.trim()
    return trimmed.startsWith('{') || trimmed.startsWith('[')
  } catch {
    return false
  }
}

export function stopProfileGateway(profileName: string): {
  ok: boolean
  message: string
} {
  const name = (profileName || 'default').trim() || 'default'
  const hermesHome = resolveProfileHermesHome(name)
  const pid = readAliveGatewayPid(hermesHome)
  if (!pid) {
    return { ok: true, message: 'not running' }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    if (errno.code === 'ESRCH') {
      return { ok: true, message: 'already stopped' }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  return { ok: true, message: 'stopped' }
}

export function readAliveGatewayPid(hermesHome: string): number | null {
  try {
    const raw = readFileSync(join(hermesHome, 'gateway.pid'), 'utf-8').trim()
    if (!raw) return null
    let pid: number | null = null
    if (/^\d+$/.test(raw)) {
      pid = Number(raw)
    } else {
      const parsed = JSON.parse(raw) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        pid = parsed.pid
      }
    }
    if (!pid || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function buildGatewayRunArgs(
  profileName: string,
  replace: boolean,
): Array<string> {
  const args = ['--profile', profileName, 'gateway', 'run']
  if (replace) args.push('--replace')
  return args
}

/** Spawn one profile's API gateway on a dedicated port. Does not replace other profiles. */
export async function spawnProfileGateway(
  options: StartGatewayOptions = {},
): Promise<StartHermesAgentResult> {
  const profileName =
    (options.profileName || getActiveProfileName() || 'default').trim() ||
    'default'
  const hermesHome = resolveProfileHermesHome(profileName)
  const port = options.port ?? HERMES_START_PORT
  let apiEnv: Record<string, string>
  try {
    apiEnv = ensureProfileApiServerEnv(profileName, port)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      profile: profileName,
      hermesHome,
    }
  }
  const hermesEnv = readHermesEnv(hermesHome)
  const hermesBin = resolveHermesBinary()
  const agentDir = resolveHermesAgentDir()
  const stalePid = readAliveGatewayPid(hermesHome)
  const alreadyHealthy = await isHermesAgentHealthy(port, 250)
  const owned = profileOwnsPort(profileName, port)
  if (alreadyHealthy && owned && !options.forceReplace) {
    return {
      ok: true,
      message: 'already running',
      profile: profileName,
      hermesHome,
    }
  }
  if (!apiEnv.API_SERVER_KEY) {
    return {
      ok: false,
      error: `profile ${profileName} is missing API_SERVER_KEY; Hermes will not bind :${port}`,
    }
  }
  const replace =
    options.forceReplace === true ||
    (stalePid !== null && !alreadyHealthy) ||
    (alreadyHealthy && !owned)
  const waitForHealthy = options.waitForHealthy !== false

  let command: string
  let commandArgs: Array<string>
  let cwd: string | undefined

  if (hermesBin) {
    command = hermesBin
    commandArgs = buildGatewayRunArgs(profileName, replace)
    cwd = agentDir ?? undefined
  } else if (agentDir) {
    command = resolveHermesPython(agentDir)
    commandArgs = [
      '-m',
      'uvicorn',
      'webapi.app:app',
      '--host',
      hermesEnv.API_SERVER_HOST || '127.0.0.1',
      '--port',
      String(port),
    ]
    cwd = agentDir
  } else {
    return {
      ok: false,
      error:
        'hermes-agent not found. Run the installer: curl -fsSL https://hermes-workspace.com/install.sh | bash',
    }
  }

  let logFd: number | undefined
  try {
    const logPath = join(getStateDir(), `gateway-spawn-${profileName}.log`)
    logFd = openSync(logPath, 'a')
  } catch {
    logFd = undefined
  }

  // Cursor agent shells may inject bubblewrap netns via CURSOR_SANDBOX_*;
  // never inherit those into a long-lived gateway or /health becomes unreachable.
  const parentEnv: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(parentEnv)) {
    if (
      key === 'CURSOR_SANDBOX' ||
      key.startsWith('CURSOR_SANDBOX_') ||
      key === '__CURSOR_SANDBOX_ENV_RESTORE'
    ) {
      delete parentEnv[key]
    }
  }

  const spawnEnv = {
    ...parentEnv,
    ...hermesEnv,
    ...apiEnv,
    HERMES_HOME: hermesHome,
    API_SERVER_ENABLED: 'true',
    API_SERVER_PORT: String(port),
    API_SERVER_HOST:
      apiEnv.API_SERVER_HOST || hermesEnv.API_SERVER_HOST || '127.0.0.1',
    HERMES_ACCEPT_HOOKS: '1',
    PATH: [
      resolve(homedir(), '.claude', 'bin'),
      resolve(homedir(), '.local', 'bin'),
      agentDir ? resolve(agentDir, '.venv', 'bin') : '',
      agentDir ? resolve(agentDir, 'venv', 'bin') : '',
      process.env.PATH || '',
    ]
      .filter(Boolean)
      .join(':'),
  }
  const spawnOpts = {
    cwd,
    detached: true,
    stdio: (logFd === undefined
      ? 'ignore'
      : ['ignore', logFd, logFd]) as import('node:child_process').StdioOptions,
    env: spawnEnv,
  }
  const setsid = resolve('/usr/bin/setsid')
  const child = existsSync(setsid)
    ? spawn(setsid, ['-f', command, ...commandArgs], spawnOpts)
    : spawn(command, commandArgs, spawnOpts)

  child.unref()

  if (!waitForHealthy) {
    return {
      ok: true,
      pid: child.pid,
      message: 'starting',
      profile: profileName,
      hermesHome,
    }
  }

  // forceReplace: the previous occupant may still answer /health for a
  // moment — wait for a fresh bind instead of treating leftover health
  // as success.
  const skipImmediateHealth = options.forceReplace === true
  if (!skipImmediateHealth && (await isHermesAgentHealthy(port, 250))) {
    return {
      ok: true,
      pid: child.pid,
      message: replace ? 'restarted' : 'started',
      profile: profileName,
      hermesHome,
    }
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 100))
    if (await isHermesAgentHealthy(port, 200)) {
      return {
        ok: true,
        pid: child.pid,
        message: replace ? 'restarted' : 'started',
        profile: profileName,
        hermesHome,
      }
    }
  }

  return {
    ok: false,
    error: `gateway for ${profileName} did not become healthy on :${port}`,
  }
}

export async function startHermesAgent(
  options: StartGatewayOptions = {},
): Promise<StartHermesAgentResult> {
  const profileName =
    (options.profileName || getActiveProfileName() || 'default').trim() ||
    'default'

  const { ensureProfileGateway, isGatewayPoolEnabled } =
    await import('./gateway-pool')
  if (isGatewayPoolEnabled()) {
    return ensureProfileGateway(profileName, {
      forceReplace: options.forceReplace,
    })
  }

  const port = options.port ?? HERMES_START_PORT

  if (!options.forceReplace && (await isHermesAgentHealthy(port))) {
    return {
      ok: true,
      message: 'already running',
      profile: profileName,
      hermesHome: resolveProfileHermesHome(profileName),
    }
  }

  if (startPromise) {
    return startPromise
  }

  startPromise = (async () => {
    try {
      return await spawnProfileGateway({ ...options, profileName, port })
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })()

  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}
