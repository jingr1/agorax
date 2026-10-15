import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  readWorkerMessages,
  type SwarmChatMessage,
} from '../../server/swarm-chat-reader'
import {
  ensureLiveTmuxSession,
  tmuxSessionHasHermesTui,
  tmuxSessionHasShellReady,
} from './swarm-dispatch'
import { tmuxPasteWithBracketedPaste } from '../../server/swarm-tmux-delivery'

type DirectChatRequest = {
  workerId?: unknown
  prompt?: unknown
  limit?: unknown
}

type DirectChatResponse = {
  ok: boolean
  workerId: string
  delivered: boolean
  delivery?: 'tmux'
  error?: string | null
  sessionId: string | null
  sessionTitle: string | null
  messages: Array<SwarmChatMessage>
  source: 'state.db' | 'unavailable'
  fetchedAt: number
}

const MAX_OUTPUT_CHARS = 200_000
const DEFAULT_LIMIT = 30

function validateWorkerId(workerId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workerId)
}

function getProfilesDir(): string {
  const base = process.env.HERMES_HOME
  if (base) {
    const parts = base.split('/').filter(Boolean)
    if (parts.length >= 2 && parts.at(-2) === 'profiles') {
      return base.split('/').slice(0, -1).join('/')
    }
    return join(base, 'profiles')
  }
  return join(homedir(), '.hermes', 'profiles')
}

function getProfilePath(workerId: string): string {
  return join(getProfilesDir(), workerId)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function execFileAsync(
  cmd: string,
  args: Array<string>,
  timeout = 8_000,
  input?: string,
): Promise<
  { ok: true; stdout: string; stderr: string } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer: MAX_OUTPUT_CHARS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: stderr?.toString().trim() || error.message,
          })
          return
        }
        resolve({
          ok: true,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        })
      },
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

async function sendPromptToLiveSession(
  workerId: string,
  prompt: string,
): Promise<{ ok: true; delivery: 'tmux' } | { ok: false; error: string }> {
  let ensured = await ensureLiveTmuxSession(workerId)
  if (!ensured.ok) return { ok: false, error: ensured.error }
  let { tmuxBin, sessionName, transport } = ensured

  // Guard: the session must actually be running Hermes (TUI or CLI). If the
  // pane is only a bare shell, pasting would execute the prompt as a shell
  // command instead of sending it to the agent.
  const hasHermes =
    transport === 'cli'
      ? await tmuxSessionHasShellReady(tmuxBin, sessionName)
      : await tmuxSessionHasHermesTui(tmuxBin, sessionName)
  if (!hasHermes) {
    // Kill the stale shell-only session and recreate it with Hermes running.
    const killed = await execFileAsync(tmuxBin, [
      'kill-session',
      '-t',
      sessionName,
    ])
    if (!killed.ok) {
      return {
        ok: false,
        error: `Session ${sessionName} has no Hermes agent and could not be killed: ${killed.error}`,
      }
    }
    ensured = await ensureLiveTmuxSession(workerId)
    if (!ensured.ok) return { ok: false, error: ensured.error }
    tmuxBin = ensured.tmuxBin
    sessionName = ensured.sessionName
    transport = ensured.transport
  }

  const normalizedPrompt = prompt.replace(/\r\n/g, '\n')

  // TUI mode: prompt_toolkit handles Ctrl-C as exit by default, so do not
  // send C-c/C-u. Just paste with bracketed-paste markers so the content is
  // submitted as a single block.
  if (transport === 'tui') {
    try {
      await tmuxPasteWithBracketedPaste(tmuxBin, sessionName, normalizedPrompt)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  } else {
    const bufferName = `swarm-direct-chat-${workerId}`
    const loaded = await execFileAsync(
      tmuxBin,
      ['load-buffer', '-b', bufferName, '-'],
      8_000,
      normalizedPrompt,
    )
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const cleared = await execFileAsync(tmuxBin, [
      'send-keys',
      '-t',
      sessionName,
      'C-c',
    ])
    if (!cleared.ok) return { ok: false, error: cleared.error }
    await sleep(100)
    const clearedLine = await execFileAsync(tmuxBin, [
      'send-keys',
      '-t',
      sessionName,
      'C-u',
    ])
    if (!clearedLine.ok) return { ok: false, error: clearedLine.error }
    const pasted = await execFileAsync(tmuxBin, [
      'paste-buffer',
      '-d',
      '-b',
      bufferName,
      '-t',
      sessionName,
    ])
    if (!pasted.ok) return { ok: false, error: pasted.error }
  }

  await sleep(120)
  const entered = await execFileAsync(tmuxBin, [
    'send-keys',
    '-t',
    sessionName,
    'Enter',
  ])
  if (!entered.ok) return { ok: false, error: entered.error }

  return { ok: true, delivery: 'tmux' }
}

export const Route = createFileRoute('/api/swarm-direct-chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: DirectChatRequest
        try {
          body = (await request.json()) as DirectChatRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const workerId =
          typeof body.workerId === 'string' ? body.workerId.trim() : ''
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        const limit =
          typeof body.limit === 'number' && Number.isFinite(body.limit)
            ? Math.max(1, Math.min(100, Math.floor(body.limit)))
            : DEFAULT_LIMIT

        if (!workerId || !validateWorkerId(workerId)) {
          return json({ error: 'Invalid workerId' }, { status: 400 })
        }
        if (!prompt) {
          return json({ error: 'Missing prompt' }, { status: 400 })
        }

        const profilePath = getProfilePath(workerId)
        const baselineChat = readWorkerMessages(profilePath, limit)

        const delivered = await sendPromptToLiveSession(workerId, prompt)
        if (!delivered.ok) {
          return json(
            {
              ok: false,
              workerId,
              delivered: false,
              error: delivered.error,
              sessionId: baselineChat.sessionId,
              sessionTitle: baselineChat.sessionTitle,
              messages: baselineChat.messages,
              source: baselineChat.ok ? 'state.db' : 'unavailable',
              fetchedAt: Date.now(),
            } satisfies DirectChatResponse,
            { status: 500 },
          )
        }

        // Return immediately after tmux delivery. Swarm2LiveChat polls
        // /api/swarm-chat for replies — blocking here for up to 120s tripped the
        // dev server's 15s socket timeout and surfaced as HTTP 502.
        const chat = readWorkerMessages(profilePath, limit)
        return json({
          ok: chat.ok,
          workerId,
          delivered: true,
          delivery: 'tmux',
          error: chat.ok
            ? null
            : (chat.error ?? 'Failed to read worker messages'),
          sessionId: chat.sessionId,
          sessionTitle: chat.sessionTitle,
          messages: chat.messages,
          source: chat.ok ? 'state.db' : 'unavailable',
          fetchedAt: Date.now(),
        } satisfies DirectChatResponse)
      },
    },
  },
})
