/**
 * Shared one-shot managed-agent turn runner (claude-code today).
 *
 * Used by:
 *   - POST /api/agents/:agentId/chat (1:1 SSE)
 *   - group-chat turn-executor (member turns)
 *
 * Spawns via AgentRuntimeAdapter.startRun and drains streamEvents until
 * run_exited / hard timeout. Does not probe() on the hot path.
 */
import { createCollabId } from '../collab-db'
import { issueRunToken } from '../mcp/run-tokens'
import {
  GROUP_TURN_HARD_CAP_MS,
  GROUP_TURN_POLL_MS,
  GROUP_TURN_TIMEOUT_MS,
} from '../group-chat/constants'
import { assistantTextFromMessageUpdate } from './agorax-managed-agent-events'
import { getMcpEndpoint } from './dispatch'
import {
  reconcileManagedRunActivity,
  type ReconcileManagedRunActivity,
  type ReconciledManagedRun,
} from './reconcile-managed-run-activity'
import { getAgentRuntimeRouter } from './router'
import type { AgentRuntimeAdapter, AgentRunInput, AgentStreamEvent } from './types'

export type ManagedTurnEvent = AgentStreamEvent

export type RunManagedTurnInput = {
  agentId: string
  task: string
  model?: string
  /** Claude Code `--effort`; ignored by other runtimes. */
  effort?: string
  roomId?: string | null
  /** Working directory for the managed process (room workspace / mission worktree). */
  cwd?: string | null
  /** Bound into the MCP run token (1:1 chat uses session id). */
  taskId?: string | null
  toolAllowlist?: Array<string>
  /** Soft/hard deadlines; defaults to group-chat constants. */
  softTimeoutMs?: number
  hardCapMs?: number
  pollMs?: number
  onEvent?: (event: AgentStreamEvent) => void
  /** Abort / client disconnect — interrupt the run. */
  signal?: AbortSignal
  /**
   * Interaction liveness: while a canonical pending interaction blocks the
   * turn (human answering a card), the drain loop waits past the soft
   * deadline. The hard cap still bounds the wait.
   */
  whileInteractionPending?: () => boolean
  /** Claude native session UUID (--session-id / --resume). */
  nativeSessionId?: string
  /** When true, spawn with `--resume` instead of `--session-id`. */
  nativeResume?: boolean
  /**
   * Test seam: override activity GET reconcile (WS-miss fallback).
   * Production uses {@link reconcileManagedRunActivity}.
   */
  reconcileActivity?: ReconcileManagedRunActivity
}

export type RunManagedTurnResult =
  | {
      kind: 'completed'
      runId: string
      text: string
      exitCode: number | null
      events: Array<AgentStreamEvent>
    }
  | {
      kind: 'timed_out'
      runId: string
      text: string
      events: Array<AgentStreamEvent>
    }
  | {
      kind: 'failed'
      runId?: string
      reason: string
      events: Array<AgentStreamEvent>
    }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extendDeadline(startedAt: number, deadline: number, softMs: number, hardMs: number): number {
  return Math.min(
    startedAt + hardMs,
    Math.max(deadline, Date.now() + softMs),
  )
}

export async function runManagedTurn(
  input: RunManagedTurnInput,
): Promise<RunManagedTurnResult> {
  const softMs = input.softTimeoutMs ?? GROUP_TURN_TIMEOUT_MS
  const hardMs = input.hardCapMs ?? GROUP_TURN_HARD_CAP_MS
  const pollMs = input.pollMs ?? GROUP_TURN_POLL_MS
  const events: Array<AgentStreamEvent> = []

  const router = getAgentRuntimeRouter()
  const adapter = router.getAdapter(input.agentId)
  if (!adapter) {
    return {
      kind: 'failed',
      reason: `agent not found: ${input.agentId}`,
      events,
    }
  }
  if (adapter.kind === 'hermes') {
    return {
      kind: 'failed',
      reason: 'hermes agents use the gateway session path, not runManagedTurn',
      events,
    }
  }

  const runId = createCollabId('run')
  const toolAllowlist = input.toolAllowlist ?? ['task_start', 'task_complete']
  const { token } = issueRunToken({
    kind: 'run_write',
    runId,
    participantId: input.agentId,
    assignmentId: null,
    taskId: input.taskId?.trim() || runId,
    roomId: input.roomId ?? null,
    toolAllowlist,
  })

  try {
    await adapter.startRun({
      runId,
      agentId: input.agentId,
      task: input.task,
      taskId: input.taskId?.trim() || runId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.nativeSessionId
        ? {
            nativeSessionId: input.nativeSessionId,
            nativeResume: Boolean(input.nativeResume),
          }
        : {}),
      roomId: input.roomId ?? null,
      mcp: {
        endpoint: getMcpEndpoint(),
        runToken: token,
        toolAllowlist,
      },
    })
  } catch (error) {
    return {
      kind: 'failed',
      runId,
      reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      events,
    }
  }

  return drainManagedRun(adapter, runId, {
    softMs,
    hardMs,
    pollMs,
    onEvent: input.onEvent,
    signal: input.signal,
    whileInteractionPending: input.whileInteractionPending,
    reconcileActivity: input.reconcileActivity ?? reconcileManagedRunActivity,
    events,
  })
}

function applyReconciledFacts(
  reconciled: ReconciledManagedRun,
  state: {
    text: string
    snapshotText: string
    lastError: string | null
    exitCode: number | null
  },
): {
  text: string
  snapshotText: string
  lastError: string | null
  exitCode: number | null
} {
  return {
    text: state.text,
    snapshotText: reconciled.text.trim() || state.snapshotText,
    lastError: reconciled.error ?? state.lastError,
    exitCode: reconciled.exitCode ?? state.exitCode,
  }
}

async function drainManagedRun(
  adapter: AgentRuntimeAdapter,
  runId: string,
  opts: {
    softMs: number
    hardMs: number
    pollMs: number
    onEvent?: (event: AgentStreamEvent) => void
    signal?: AbortSignal
    whileInteractionPending?: () => boolean
    reconcileActivity?: ReconcileManagedRunActivity
    events: Array<AgentStreamEvent>
  },
): Promise<RunManagedTurnResult> {
  let text = ''
  /** Durable message_update assistant snapshots replace (not append) text. */
  let snapshotText = ''
  let exitCode: number | null = null
  let sawExit = false
  let lastError: string | null = null
  const startedAt = Date.now()
  let deadline = startedAt + opts.softMs
  const reconcile = opts.reconcileActivity

  const onAbort = () => {
    void adapter.interrupt(runId, 'aborted')
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const finishEmptyFailure = async (
    fallbackReason: string,
    timedOut: boolean,
  ): Promise<RunManagedTurnResult> => {
    if (reconcile) {
      const recovered = await reconcile(runId).catch(() => null)
      if (recovered?.settled) {
        ;({ text, snapshotText, lastError, exitCode } = applyReconciledFacts(
          recovered,
          { text, snapshotText, lastError, exitCode },
        ))
      }
    }
    const trimmed = (text.trim() || snapshotText.trim())
    if (trimmed) {
      return timedOut
        ? { kind: 'timed_out', runId, text: trimmed, events: opts.events }
        : {
            kind: 'completed',
            runId,
            text: trimmed,
            exitCode,
            events: opts.events,
          }
    }
    return {
      kind: 'failed',
      runId,
      reason: lastError ?? fallbackReason,
      events: opts.events,
    }
  }

  try {
    const iterator = adapter.streamEvents(runId)[Symbol.asyncIterator]()
    let pending = iterator.next()

    while (!sawExit) {
      if (opts.signal?.aborted) {
        await adapter.interrupt(runId, 'aborted').catch(() => undefined)
        return {
          kind: 'failed',
          runId,
          reason: 'aborted',
          events: opts.events,
        }
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // A canonical pending interaction blocks the turn until a human
        // answers the card. Keep waiting, bounded by the hard cap.
        if (
          opts.whileInteractionPending?.() &&
          Date.now() < startedAt + opts.hardMs
        ) {
          deadline = startedAt + opts.hardMs
          continue
        }
        await adapter.interrupt(runId, 'group turn hard timeout').catch(() => undefined)
        const trimmed = (text.trim() || snapshotText.trim())
        if (trimmed) {
          return { kind: 'timed_out', runId, text: trimmed, events: opts.events }
        }
        return finishEmptyFailure(
          'managed turn timed out with empty reply',
          true,
        )
      }

      const raced = await Promise.race([
        pending.then((result) => ({ tag: 'next' as const, result })),
        sleep(Math.min(remaining, opts.pollMs)).then(() => ({
          tag: 'tick' as const,
        })),
      ])

      if (raced.tag === 'tick') {
        // WS can miss terminal turn_update (publish rejected). Poll activity
        // so quota/provider failures surface without waiting for soft timeout.
        if (reconcile) {
          const recovered = await reconcile(runId).catch(() => null)
          if (recovered?.settled) {
            ;({ text, snapshotText, lastError, exitCode } = applyReconciledFacts(
              recovered,
              { text, snapshotText, lastError, exitCode },
            ))
            sawExit = true
            await adapter
              .interrupt(runId, 'reconciled settled turn')
              .catch(() => undefined)
            const trimmedEarly = (text.trim() || snapshotText.trim())
            const errEarly = lastError ?? recovered.error
            // Error-only settle (quota / rate limit): don't wait for stream EOF.
            if (!trimmedEarly && errEarly) {
              return {
                kind: 'failed',
                runId,
                reason: errEarly,
                events: opts.events,
              }
            }
            break
          }
        }
        continue
      }

      const { result } = raced
      pending = iterator.next()
      if (result.done) break

      const event = result.value
      opts.events.push(event)
      opts.onEvent?.(event)
      deadline = extendDeadline(startedAt, deadline, opts.softMs, opts.hardMs)

      if (event.type === 'text_delta' && event.text) {
        text += event.text
      } else if (event.type === 'error') {
        lastError = event.message
      } else if (event.type === 'run_exited') {
        exitCode = event.exitCode
        sawExit = true
      } else if (event.type === 'activity') {
        const snap = assistantTextFromMessageUpdate(event.activity)
        if (snap) snapshotText = snap
      }
    }
  } catch (error) {
    return {
      kind: 'failed',
      runId,
      reason: error instanceof Error ? error.message : String(error),
      events: opts.events,
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }

  const trimmed = (text.trim() || snapshotText.trim())
  if (trimmed) {
    // Quota / provider failures often land as assistant text with exitCode≠0.
    // Surface them as completed text so group-chat can post the reason instead
    // of silently advancing the watermark on an empty failure.
    return { kind: 'completed', runId, text: trimmed, exitCode, events: opts.events }
  }
  return finishEmptyFailure(
    lastError ??
      (exitCode != null && exitCode !== 0
        ? `run exited with code ${exitCode} and empty reply`
        : 'empty reply'),
    false,
  )
}

/**
 * Start a managed run and yield stream events (for SSE relay).
 * Caller owns response lifecycle; this does not apply group-chat timeouts.
 */
export async function startManagedChatRun(input: {
  runId?: string
  agentId: string
  task: string
  model?: string
  effort?: string
  content?: AgentRunInput['content']
  /** UI-only user text when task/content carry injected platform skills. */
  displayPrompt?: string
  sessionId?: string | null
  roomId?: string | null
  cwd?: string | null
  probe?: boolean
  nativeSessionId?: string
  nativeResume?: boolean
}): Promise<
  | {
      ok: true
      runId: string
      adapter: AgentRuntimeAdapter
      sessionId: string
    }
  | { ok: false; status: number; error: string }
> {
  const router = getAgentRuntimeRouter()
  const adapter = router.getAdapter(input.agentId)
  if (!adapter) {
    return { ok: false, status: 404, error: `agent not found: ${input.agentId}` }
  }
  if (adapter.kind === 'hermes') {
    return {
      ok: false,
      status: 400,
      error: 'hermes agents use /api/send-stream, not this endpoint',
    }
  }

  if (input.probe !== false) {
    const probe = await adapter.probe()
    if (!probe.available) {
      return {
        ok: false,
        status: 503,
        error: probe.detail || `agent ${input.agentId} is not available`,
      }
    }
  }

  const runId = input.runId?.trim() || createCollabId('run')
  const chatSessionId = input.sessionId?.trim() || `cc-${Date.now()}`
  const toolAllowlist = ['task_start', 'task_complete']
  const { token } = issueRunToken({
    kind: 'run_write',
    runId,
    participantId: input.agentId,
    assignmentId: null,
    taskId: chatSessionId,
    roomId: input.roomId ?? null,
    toolAllowlist,
  })

  const displayPrompt = input.displayPrompt?.trim() ?? ''
  try {
    await adapter.startRun({
      runId,
      agentId: input.agentId,
      task: input.task,
      ...(input.content ? { content: input.content } : {}),
      ...(displayPrompt ? { displayPrompt } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.nativeSessionId
        ? {
            nativeSessionId: input.nativeSessionId,
            nativeResume: Boolean(input.nativeResume),
          }
        : {}),
      roomId: input.roomId ?? null,
      mcp: {
        endpoint: getMcpEndpoint(),
        runToken: token,
        toolAllowlist,
      },
    })
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { ok: true, runId, adapter, sessionId: chatSessionId }
}
