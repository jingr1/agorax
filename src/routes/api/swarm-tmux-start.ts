import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { getProfilesDir } from '../../server/hermes-paths'
import { rosterByWorkerId } from '../../server/swarm-roster'
import { handoffPath, readHandoff } from '../../server/handoff'
import {
  buildHermesTmuxShellCommand,
  buildHermesTmuxTuiCommand,
  resolveTmuxTransportMode,
  tmuxPaneLooksLikeHermesTui,
  tmuxPaneLooksLikeShellReady,
  type TmuxTransportMode,
} from '../../server/swarm-tmux-delivery'

/**
 * POST /api/swarm-tmux-start
 * Body: { workerId: "swarm1" }
 *
 * Idempotently ensures a long-lived tmux session exists for a worker.
 * - tmux-tui (default): `hermes chat --tui` — dispatch pastes into TUI prompt
 * - tmux-cli (HERMES_SWARM_TMUX_MODE=cli): `bash -l` — dispatch runs `hermes chat -q` per task
 *
 * Returns: { workerId, sessionName, alreadyRunning, started, transportMode }
 */

type StartRequest = {
  workerId?: unknown
}

const TMUX_BIN_CANDIDATES = [
  process.env.TMUX_BIN,
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  join(homedir(), '.local', 'bin', 'tmux'),
  'tmux',
].filter((value): value is string => Boolean(value))

function resolveTmuxBin(): string | null {
  for (const candidate of TMUX_BIN_CANDIDATES) {
    if (candidate.includes('/')) {
      // Trust an explicit TMUX_BIN override even if existsSync misses it
      // (some sandbox / launchd setups report false negatives).
      if (candidate === process.env.TMUX_BIN) {
        return candidate
      }
      // For absolute candidate paths, only use them if they actually exist.
      // Otherwise a hardcoded macOS Homebrew path will break Linux hosts.
      if (existsSync(candidate)) {
        return candidate
      }
      continue
    }
    // Bare command: let execFile resolve it via PATH.
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

function captureTmuxPane(
  tmuxBin: string,
  sessionName: string,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      tmuxBin,
      ['capture-pane', '-p', '-t', sessionName, '-S', '-120'],
      (error, stdout) => {
        resolve(error ? '' : stdout.toString().trim())
      },
    )
  })
}

function getPaneCurrentCommand(
  tmuxBin: string,
  sessionName: string,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      tmuxBin,
      ['list-panes', '-t', sessionName, '-F', '#{pane_current_command}'],
      (error, stdout) => {
        resolve(error ? '' : stdout.toString().trim().split('\n')[0] || '')
      },
    )
  })
}

async function sessionHasHermesTui(
  tmuxBin: string,
  sessionName: string,
): Promise<boolean> {
  const pane = await captureTmuxPane(tmuxBin, sessionName)
  return tmuxPaneLooksLikeHermesTui(pane)
}

async function sessionHasShellReady(
  tmuxBin: string,
  sessionName: string,
): Promise<boolean> {
  const pane = await captureTmuxPane(tmuxBin, sessionName)
  const paneCommand = await getPaneCurrentCommand(tmuxBin, sessionName)
  return tmuxPaneLooksLikeShellReady(pane, paneCommand)
}

function resolveGithubToken(): string | null {
  const direct = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  return direct?.trim() || null
}

function validateWorkerId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startSession(
  tmuxBin: string,
  sessionName: string,
  profilePath: string,
  cwd: string,
  workerId: string,
  transport: TmuxTransportMode,
): Promise<{ ok: boolean; error?: string }> {
  const handoff = readHandoff(workerId)
  const handoffEnv = handoff
    ? `HERMES_HANDOFF_PATH='${handoffPath(workerId).replace(/'/g, `'\\\\''`)}' `
    : ''
  const hermesBin = resolveHermesBin()
  const ghToken = resolveGithubToken()
  const startCommand =
    transport === 'cli'
      ? `${handoffEnv}${buildHermesTmuxShellCommand({ profilePath, hermesBin, ghToken })}`
      : `${handoffEnv}${buildHermesTmuxTuiCommand({ profilePath, hermesBin, ghToken })}`
  return new Promise((resolve) => {
    const child = execFile(
      tmuxBin,
      ['new-session', '-d', '-s', sessionName, '-c', cwd, startCommand],
      { timeout: 8_000 },
      async (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: stderr.toString().trim() || error.message,
          })
          return
        }
        // Wait briefly for tmux to register the session, then poll readiness
        // with a generous budget. TUI startup can take several seconds on the
        // first run while dependencies are resolved and the prompt renders.
        await sleep(1_000)
        if (!(await tmuxHasSession(tmuxBin, sessionName))) {
          resolve({
            ok: false,
            error: `Hermes worker session ${sessionName} exited during startup. Check profile and Hermes logs.`,
          })
          return
        }
        const isReady =
          transport === 'cli'
            ? () => sessionHasShellReady(tmuxBin, sessionName)
            : () => sessionHasHermesTui(tmuxBin, sessionName)
        const maxRetries = 10
        let ready = false
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          ready = await isReady()
          if (ready) break
          await sleep(1_000)
        }
        if (!ready) {
          resolve({
            ok: false,
            error: `Worker session ${sessionName} started but ${transport === 'cli' ? 'shell' : 'TUI'} is not ready after ${maxRetries}s`,
          })
          return
        }
        if (handoff && transport === 'tui') {
          await injectHandoffPrompt(tmuxBin, sessionName, workerId)
        }
        resolve({ ok: true })
      },
    )
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message })
    })
  })
}

async function injectHandoffPrompt(
  tmuxBin: string,
  sessionName: string,
  workerId: string,
): Promise<void> {
  const handoff = readHandoff(workerId)
  if (!handoff) return
  const prompt =
    `CONTEXT_HANDOFF. You latest structured handoff is at ${handoffPath(workerId)}. ` +
    `Read it (and matching .md file) to re-ground, then wait for the next assignment.`
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        tmuxBin,
        ['load-buffer', '-b', `swarm-start-${workerId}`, '-'],
        {
          encoding: 'utf8',
        },
      )
      child.stdin?.write(prompt)
      child.stdin?.end()
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`load-buffer exited ${code}`))
        resolve()
      })
      child.on('error', reject)
    })
    // Never send Ctrl-C into Hermes TUI — it exits the agent. Paste only.
    const target = `${sessionName}:0.0`
    await new Promise<void>((resolve, reject) => {
      execFile(
        tmuxBin,
        ['paste-buffer', '-d', '-b', `swarm-start-${workerId}`, '-t', target],
        (err) => {
          if (err) return reject(err)
          setTimeout(() => {
            execFile(
              tmuxBin,
              ['send-keys', '-t', target, 'Enter'],
              (enterErr) => {
                if (enterErr) return reject(enterErr)
                resolve()
              },
            )
          }, 150)
        },
      )
    })
  } catch (err) {
    console.error(
      `[swarm-tmux-start] failed to inject handoff for ${workerId}:`,
      err,
    )
  }
}

function resolveWorkerCwd(workerId: string): string {
  const worker = rosterByWorkerId([workerId]).get(workerId)
  const wrapperName = worker?.wrapper?.trim() || workerId
  const wrapperPath = join(homedir(), '.local', 'bin', wrapperName)
  if (existsSync(wrapperPath)) {
    try {
      const text = readFileSync(wrapperPath, 'utf8')
      const m = text.match(/cd\\s+'([^']+)'/)
      if (m && m[1] && existsSync(m[1])) return m[1]
    } catch {
      /* noop */
    }
  }
  return homedir()
}

export const Route = createFileRoute('/api/swarm-tmux-start')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: StartRequest
        try {
          body = (await request.json()) as StartRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const workerId =
          typeof body.workerId === 'string' ? body.workerId.trim() : ''
        if (!workerId || !validateWorkerId(workerId)) {
          return json(
            { error: 'workerId required (alnum, _, -; ≤64 chars)' },
            { status: 400 },
          )
        }

        const profilesDir = getProfilesDir()
        const profilePath = join(profilesDir, workerId)
        // Skip existsSync gate; tmux new-session will fail loudly if
        // path is bogus, and sandbox quirks on this host make existsSync
        // unreliable for parent dirs even when leaf paths work.
        // We still verify the wrapper exists as a sanity check.
        const worker = rosterByWorkerId([workerId]).get(workerId)
        const wrapperName = worker?.wrapper?.trim() || workerId
        const wrapper = join(homedir(), '.local', 'bin', wrapperName)
        if (!existsSync(wrapper)) {
          return json(
            { error: `No wrapper for ${workerId} at ${wrapper}` },
            { status: 404 },
          )
        }

        const tmuxBin = resolveTmuxBin()
        if (!tmuxBin) {
          return json(
            { error: 'tmux not installed on this host' },
            { status: 503 },
          )
        }

        const sessionName = `swarm-${workerId}`
        const transportMode = resolveTmuxTransportMode()
        const sessionExists = await tmuxHasSession(tmuxBin, sessionName)
        const sessionUsable =
          sessionExists && (await tmuxSessionUsable(tmuxBin, sessionName))
        const sessionReady =
          sessionUsable &&
          (transportMode === 'cli'
            ? await sessionHasShellReady(tmuxBin, sessionName)
            : await sessionHasHermesTui(tmuxBin, sessionName))
        if (sessionUsable && sessionReady) {
          return json({
            workerId,
            sessionName,
            alreadyRunning: true,
            started: false,
            tmuxBin,
            transportMode,
          })
        }
        if (sessionExists) {
          await tmuxKillSession(tmuxBin, sessionName)
        }

        const cwd = resolveWorkerCwd(workerId)
        const result = await startSession(
          tmuxBin,
          sessionName,
          profilePath,
          cwd,
          workerId,
          transportMode,
        )
        if (!result.ok) {
          return json(
            { error: result.error ?? 'tmux new-session failed' },
            { status: 500 },
          )
        }

        return json({
          workerId,
          sessionName,
          alreadyRunning: false,
          started: true,
          tmuxBin,
          transportMode,
          cwd,
        })
      },
    },
  },
})
