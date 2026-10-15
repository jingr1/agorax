import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveLanggraphWorkspaceRoot(): string {
  const override = process.env.AGORAX_ROOT
  if (override) return override
  return process.cwd()
}

/**
 * Prefer the package venv, then HERMES_LANGGRAPH_PYTHON, then python3 on PATH.
 * Always return an executable path that exists when possible so detached spawn
 * does not emit an unhandled ENOENT and crash the Workspace process.
 */
export function resolveLanggraphPythonBin(): string {
  const override = process.env.HERMES_LANGGRAPH_PYTHON?.trim()
  if (override && existsSync(override)) return override

  const workspaceRoot = resolveLanggraphWorkspaceRoot()
  const candidates = [
    join(
      workspaceRoot,
      'hermes_langgraph_orchestrator',
      '.venv',
      'bin',
      'python',
    ),
    join(
      workspaceRoot,
      'hermes_langgraph_orchestrator',
      '.venv',
      'bin',
      'python3',
    ),
    override || '',
    'python3',
    'python',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    // Bare command name — resolve via `command -v` when possible.
    const which = spawnSync('/bin/sh', ['-c', `command -v ${candidate}`], {
      encoding: 'utf8',
    })
    const resolved = which.stdout?.trim()
    if (which.status === 0 && resolved && existsSync(resolved)) return resolved
  }

  // Last resort: keep the conventional venv path so error messages stay clear.
  return (
    override ||
    join(
      workspaceRoot,
      'hermes_langgraph_orchestrator',
      '.venv',
      'bin',
      'python',
    )
  )
}

export function langgraphPythonMissingHint(pythonBin: string): string {
  const orch = join(
    resolveLanggraphWorkspaceRoot(),
    'hermes_langgraph_orchestrator',
  )
  return (
    `LangGraph Python not found at ${pythonBin}. ` +
    `Create the venv: cd ${orch} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
  )
}

function langgraphSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const workspaceRoot = resolveLanggraphWorkspaceRoot()
  const pythonPath = [workspaceRoot, env.PYTHONPATH].filter(Boolean).join(':')
  return { ...env, PYTHONPATH: pythonPath }
}

export function parseJsonFromStdout(stdout: string): unknown {
  // Prefer array payloads (e.g. --list-active-gates) when `[` appears before `{`.
  // Otherwise slicing from the first `{` leaves trailing `,...]` and JSON.parse fails.
  const objStart = stdout.indexOf('{')
  const arrStart = stdout.indexOf('[')
  let start = -1
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart
  } else if (objStart !== -1) {
    start = objStart
  }
  if (start === -1) {
    throw new Error('No JSON object or array found in Python output')
  }
  return JSON.parse(stdout.slice(start))
}

export function spawnLanggraphDetached(
  args: Array<string>,
  env: NodeJS.ProcessEnv = process.env,
): { pid: number | null; logFile: string } {
  const python = resolveLanggraphPythonBin()
  if (!existsSync(python) && (python.includes('/') || python.includes('\\'))) {
    throw new Error(langgraphPythonMissingHint(python))
  }

  const logDir = join(homedir(), '.hermes', 'logs')
  mkdirSync(logDir, { recursive: true })
  const missionId =
    args[args.indexOf('--mission-id') + 1] ?? `lg-${Date.now().toString(36)}`
  const logFile = join(logDir, `langgraph-${missionId}.log`)
  const logFd = openSync(logFile, 'a')
  const child = spawn(
    python,
    ['-m', 'hermes_langgraph_orchestrator', ...args],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: langgraphSpawnEnv(env),
    },
  )
  // Detached spawn emits async 'error' on ENOENT — must handle or Node crashes.
  child.on('error', (error) => {
    try {
      appendFileSync(
        logFile,
        `[langgraph] spawn failed (${python}): ${error.message}\n`,
      )
    } catch {
      console.error('[langgraph] spawn failed:', error)
    }
  })
  child.unref()
  closeSync(logFd)
  return { pid: child.pid ?? null, logFile }
}

export function runLanggraphSync(
  args: Array<string>,
  env: NodeJS.ProcessEnv = process.env,
): {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error: string | null
} {
  const python = resolveLanggraphPythonBin()
  if (!existsSync(python) && (python.includes('/') || python.includes('\\'))) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      status: null,
      error: langgraphPythonMissingHint(python),
    }
  }
  const result = spawnSync(
    python,
    ['-m', 'hermes_langgraph_orchestrator', ...args],
    {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: langgraphSpawnEnv(env),
    },
  )
  if (result.error) {
    const message = result.error.message.includes('ENOENT')
      ? langgraphPythonMissingHint(python)
      : result.error.message
    return {
      ok: false,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      error: message,
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      error: result.stderr?.slice(0, 2000) || 'Orchestrator exited with error',
    }
  }
  return {
    ok: true,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    error: null,
  }
}
