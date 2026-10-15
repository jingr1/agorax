/**
 * Terminal sessions using Python PTY helper.
 * Gives us real PTY (echo, colors, resize) without node-pty native addon.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import EventEmitter from 'node:events'
import { isTmuxAttachCommand } from '../lib/tmux-attach'
import type { ChildProcess } from 'node:child_process'

export type TerminalSessionEvent = {
  event: string
  payload: unknown
}

export type TerminalSession = {
  id: string
  createdAt: number
  emitter: EventEmitter
  sendInput: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
  /**
   * Mark that all live SSE listeners have detached. Starts an idle timer that
   * will reap the PTY if no listener reattaches in time. Lets the session
   * survive transient disconnects (network blips, browser tab suspension,
   * HMR reload) without killing the user's shell. See #298.
   */
  markDetached: () => void
  /** Cancel a pending detached-reap timer (called when a new listener attaches). */
  markAttached: () => void
}

// How long an unattached PTY session stays alive before it's reaped, in ms.
// Long enough to absorb tab suspension and short network blips, short enough
// that abandoned tabs don't pile up forever. Override with HERMES_TERMINAL_DETACH_TTL_MS.
const DETACH_TTL_MS = (() => {
  const raw = process.env.HERMES_TERMINAL_DETACH_TTL_MS
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  return 5 * 60_000 // 5 minutes
})()

const sessions = new Map<string, TerminalSession>()

// Resolve path to pty-helper.py relative to this file
const __dirname_resolved =
  typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
const PTY_HELPER = resolve(__dirname_resolved, 'pty-helper.py')

/**
 * Strip IDE shell-integration leakage from the Node process env before
 * spawning an embedded PTY.
 *
 * When Agorax is started from a Cursor/VS Code integrated terminal, that
 * shell exports `PROMPT_COMMAND=__vsc_prompt_cmd_original` (or a wrapper that
 * calls it) after sourcing `shellIntegration-bash.sh`. The function only
 * exists in that Cursor-owned shell. Spreading `process.env` into our PTY
 * inherits the name without defining the function → every prompt prints
 * `__vsc_prompt_cmd_original: command not found`. A normal (non-IDE)
 * terminal never has this export, so the bug looks Agorax-only.
 */
export function sanitizePtyEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    // Never inherit IDE prompt hooks — let bashrc rebuild a clean
    // PROMPT_COMMAND (e.g. `history -a`).
    if (key === 'PROMPT_COMMAND' || key === 'PROMPT_COMMAND_EXE') continue
    if (
      key === 'VSCODE_INJECTION' ||
      key === 'VSCODE_SHELL_INTEGRATION' ||
      key === 'VSCODE_SHELL_LOGIN' ||
      key === 'VSCODE_ENV_REPLACE' ||
      key === 'VSCODE_ENV_PREPEND' ||
      key === 'VSCODE_ENV_APPEND' ||
      key === 'VSCODE_PATH_PREFIX' ||
      key === 'VSCODE_SHELL_ENV_REPORTING'
    ) {
      continue
    }
    // Cursor/VS Code process identity; not meaningful inside a browser PTY.
    if (key.startsWith('VSCODE_') || key.startsWith('CURSOR_')) continue
    if (
      key === 'TERM_PROGRAM' &&
      (value === 'vscode' || value === 'cursor')
    ) {
      continue
    }
    if (key === 'TERM_PROGRAM_VERSION') continue
    out[key] = value
  }
  return out
}

export function createTerminalSession(params: {
  command?: Array<string>
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}): TerminalSession {
  const emitter = new EventEmitter()
  const sessionId = randomUUID()

  const home = process.env.HOME || homedir() || '/tmp'
  const defaultShell =
    process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  const command = params.command?.length
    ? params.command
    : [process.env.SHELL ?? defaultShell]
  let cwd = params.cwd ?? home
  if (cwd.startsWith('~')) {
    cwd = cwd.replace('~', home)
  }
  if (!existsSync(cwd)) {
    cwd = home
  }

  const cols = params.cols ?? 80
  const rows = params.rows ?? 24

  const baseEnv = {
    ...sanitizePtyEnv(process.env),
    ...params.env,
    // screen-256color: keeps bash *-256color PS1 colors, but skips the
    // debian/Ubuntu `xterm*|rxvt*` OSC window-title injection that otherwise
    // leaks as stacked "user@host:" lines in the web terminal.
    TERM: 'screen-256color',
    COLORTERM: 'truecolor',
    // Explicit clean hook so /etc/bash.bashrc cannot inherit a Cursor-stacked
    // PROMPT_COMMAND; ~/.bashrc may still reset this to `history -a`.
    PROMPT_COMMAND: 'history -a',
    COLUMNS: String(cols),
    LINES: String(rows),
  }
  if (isTmuxAttachCommand(command)) {
    delete baseEnv.TMUX
    delete baseEnv.TMUX_PANE
  }

  // Buffer early output before any listener registers
  const earlyBuffer: Array<TerminalSessionEvent> = []
  let hasListeners = false

  emitter.on('newListener', (eventName) => {
    if (eventName === 'event' && !hasListeners) {
      hasListeners = true
      process.nextTick(() => {
        for (const evt of earlyBuffer) {
          emitter.emit('event', evt)
        }
        earlyBuffer.length = 0
      })
    }
  })

  const pushEvent = (evt: TerminalSessionEvent) => {
    if (hasListeners) {
      emitter.emit('event', evt)
    } else {
      earlyBuffer.push(evt)
    }
  }

  // Spawn shell directly on Windows, else use Python PTY helper for POSIX
  let proc: ChildProcess
  if (process.platform === 'win32') {
    proc = spawn(command[0], command.slice(1), {
      cwd,
      env: baseEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } else {
    proc = spawn(
      'python3',
      [PTY_HELPER, cwd, String(cols), String(rows), '--', ...command],
      {
        env: baseEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  }

  proc.stdout?.on('data', (data: Buffer) => {
    pushEvent({
      event: 'data',
      payload: { data: data.toString() },
    })
  })

  // stderr from the helper itself (not the shell)
  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString()
    if (msg.trim()) {
      if (import.meta.env.DEV) console.error('[pty-helper stderr]', msg)
    }
  })

  proc.on('exit', (exitCode, signal) => {
    pushEvent({
      event: 'exit',
      payload: { exitCode, signal: signal ?? undefined },
    })
    emitter.emit('close')
    sessions.delete(sessionId)
  })

  proc.on('error', (err) => {
    pushEvent({
      event: 'error',
      payload: { message: err.message },
    })
  })

  let detachTimer: ReturnType<typeof setTimeout> | null = null
  // Panel + fullscreen TerminalWorkspace can both attach to one PTY. Only
  // start the reap timer when the last SSE listener detaches.
  let attachCount = 0

  const session: TerminalSession = {
    id: sessionId,
    createdAt: Date.now(),
    emitter,

    sendInput(data: string) {
      if (proc.stdin?.writable) {
        proc.stdin.write(data)
      }
    },

    resize(_newCols: number, _newRows: number) {
      // Send SIGWINCH to the Python helper, which propagates to the PTY
      if (proc.pid) {
        // Note: can't update env on running ChildProcess, SIGWINCH alone is sent
        try {
          process.kill(proc.pid, 'SIGWINCH')
        } catch {
          /* */
        }
      }
    },

    markDetached() {
      attachCount = Math.max(0, attachCount - 1)
      if (attachCount > 0) return
      if (detachTimer) clearTimeout(detachTimer)
      detachTimer = setTimeout(() => {
        detachTimer = null
        // Only reap if the session is still in the map and the proc is alive.
        if (sessions.get(sessionId) === session) {
          session.close()
        }
      }, DETACH_TTL_MS)
    },

    markAttached() {
      attachCount += 1
      if (detachTimer) {
        clearTimeout(detachTimer)
        detachTimer = null
      }
    },

    close() {
      if (detachTimer) {
        clearTimeout(detachTimer)
        detachTimer = null
      }
      attachCount = 0
      try {
        proc.kill('SIGTERM')
        setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* */
          }
        }, 2000)
      } catch {
        /* */
      }
      sessions.delete(sessionId)
    },
  }

  sessions.set(sessionId, session)
  return session
}

export function getTerminalSession(id: string): TerminalSession | null {
  return sessions.get(id) ?? null
}

export function closeTerminalSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.close()
}
