/**
 * Execute a single group-chat member turn.
 *
 * Bot Mode semantics (Desktop hermes-bots/group-turns.ts):
 * - Soft deadline (3 min) that EXTENDS while the stream is still producing
 *   events, capped by GROUP_TURN_HARD_CAP_MS (20 min).
 * - On true timeout (Hermes): do NOT post partial early-ack text. Return
 *   `timeout` with the pre-submit message baseline so the runner can
 *   stranded-harvest the finished reply later. Leave the gateway stream
 *   running (no abort).
 * - Managed runtimes (claude-code): one-shot adapter.run; on hard timeout
 *   interrupt and return accumulated text or failed (no stranded harvest).
 * - On success: prefer pickGroupTurnReply over the session transcript so the
 *   newest substantive (non-pass) assistant message wins — not the first ack.
 * - Infrastructure failure text (API call failed / ImportError / …) maps to
 *   `failed`, never `reply`, so it cannot enter the room and derail @mentions.
 * - Self-heals once when a poisoned Hermes session yields
 *   "No LLM provider configured".
 */
import { getHermesApiClient } from '../hermes-api-profile'
import { getMessages } from '../hermes-api'
import { runManagedTurn } from '../agent-runtime/run-managed-turn'
import {
  ensureManagedChatSession,
  recordNativeSessionId,
  resolveNativeSessionForRun,
  roomManagedSessionId,
} from '../agent-runtime/managed-chat-store'
import { upsertManagedInteractionCard } from './managed-interaction-cards'
import {
  GROUP_TURN_HARD_CAP_MS,
  GROUP_TURN_POLL_MS,
  GROUP_TURN_TIMEOUT_MS,
} from './constants'
import { forgetSession, getOrCreateSession } from './agent-session-manager'
import {
  isGroupInfraFailureText,
  isGroupPassText,
  pickGroupTurnReply,
} from './responder-utils'
import type { GroupMember, GroupTurnResult } from './types'

export type TurnExecutorOptions = {
  roomId: string
  roomTitle: string
  member: GroupMember
  prompt: string
  model?: string
  /** Room working directory — passed to managed adapters as cwd. */
  cwd?: string | null
  dbPath?: string
  onEvent?: (event: string, data: Record<string, unknown>) => void
}

const PROVIDER_CONFIG_RE = /No LLM provider configured/i

type StreamCapture = {
  replyText: string
  streamError: string | null
  /** True when the soft/hard deadline elapsed before streamChat resolved. */
  timedOut: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extendDeadline(startedAt: number, deadline: number): number {
  return Math.min(
    startedAt + GROUP_TURN_HARD_CAP_MS,
    Math.max(deadline, Date.now() + GROUP_TURN_TIMEOUT_MS),
  )
}

function isHermesMember(member: GroupMember): boolean {
  return member.runtime === 'hermes'
}

async function executeManagedMemberTurn(
  opts: TurnExecutorOptions,
): Promise<GroupTurnResult> {
  console.log(
    `[turn-executor] managed member=${opts.member.displayName} runtime=${opts.member.runtime} agent=${opts.member.participantId}`,
  )

  const sessionId = roomManagedSessionId(
    opts.roomId,
    opts.member.participantId,
  )
  ensureManagedChatSession({
    id: sessionId,
    agentId: opts.member.participantId,
    runtime: opts.member.runtime,
  })
  const native = resolveNativeSessionForRun({ sessionId })

  // Set while the canonical stream reports this turn's interaction as pending:
  // the drain loop then waits past the soft deadline (hard cap still bounds)
  // so a human can answer the room card without the run being interrupted.
  let awaitingInteraction = false

  const result = await runManagedTurn({
    agentId: opts.member.participantId,
    task: opts.prompt,
    model: opts.model,
    roomId: opts.roomId,
    cwd: opts.cwd,
    nativeSessionId: native.nativeSessionId,
    nativeResume: native.resume,
    whileInteractionPending: () => awaitingInteraction,
    onEvent: (event) => {
      if (event.type === 'text_delta') {
        opts.onEvent?.('assistant.delta', { delta: event.text })
      } else if (event.type === 'error') {
        opts.onEvent?.('error', { message: event.message })
      } else if (event.type === 'run_exited') {
        opts.onEvent?.('assistant.completed', {})
      } else if (event.type === 'native_session') {
        recordNativeSessionId({
          sessionId,
          nativeSessionId: event.sessionId,
        })
      } else if (
        event.type === 'activity' &&
        event.activity.eventType === 'interaction_update'
      ) {
        // Canonical interaction projection: persist/refresh the room card.
        // Card status is the daemon canonical status — no local pending state.
        const interaction = event.activity.data.interaction
        upsertManagedInteractionCard({
          roomId: opts.roomId,
          member: opts.member,
          runId: event.runId,
          interaction,
        })
        if (interaction.status === 'pending') {
          awaitingInteraction = true
        } else if (
          interaction.status === 'answered' ||
          interaction.status === 'superseded'
        ) {
          awaitingInteraction = false
        }
      }
    },
  })

  if (result.kind === 'completed' || result.kind === 'timed_out') {
    const text = result.text.trim()
    if (!text) {
      return {
        kind: 'failed',
        reason:
          result.kind === 'timed_out'
            ? 'managed turn timed out with empty reply'
            : 'empty reply',
      }
    }
    if (isGroupPassText(text)) return { kind: 'pass' }
    // Gateway/runtime exceptions must not enter the room as agent speech.
    if (isGroupInfraFailureText(text)) {
      return { kind: 'failed', reason: text.slice(0, 500) }
    }
    return {
      kind: 'reply',
      text,
      runId: result.runId,
    }
  }

  return { kind: 'failed', reason: result.reason }
}

async function streamOnce(
  opts: TurnExecutorOptions,
  sessionId: string,
  profile: string | null,
): Promise<StreamCapture> {
  const client =
    opts.member.runtime === 'hermes' && profile
      ? getHermesApiClient(profile)
      : undefined

  let replyAccum = ''
  let completedText: string | null = null
  let streamError: string | null = null
  const startedAt = Date.now()
  let deadline = startedAt + GROUP_TURN_TIMEOUT_MS

  const handleStreamEvent = (event: string, data: Record<string, unknown>) => {
    // Any activity means the turn is still visibly working — extend soft deadline.
    deadline = extendDeadline(startedAt, deadline)
    opts.onEvent?.(event, data)

    if (event === 'assistant.delta' && typeof data.delta === 'string') {
      replyAccum += data.delta
    }
    if (event === 'assistant.completed' && typeof data.content === 'string') {
      completedText = data.content
    }
    if (event === 'error') {
      const msg =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'string'
            ? data.error
            : 'stream error'
      streamError = msg
      console.warn(
        `[turn-executor] member=${opts.member.displayName} sse error: ${msg}`,
      )
    }
  }

  // IMPORTANT: do NOT pin profile default model/provider onto /chat/stream.
  // A request model override forces route_source=raw_request and fails with
  // "No LLM provider configured". Omitting both uses config.yaml via global.
  const effectiveModel = opts.model
  console.log(
    `[turn-executor] member=${opts.member.displayName} profile=${profile ?? 'n/a'} url=${client?.baseUrl ?? 'global'} model=${effectiveModel ?? '(profile default)'} starting stream...`,
  )

  let streamSettled = false
  let streamRejected: unknown = null

  const streamPromise = (
    client
      ? client.streamChat(
          sessionId,
          {
            message: opts.prompt,
            ...(effectiveModel ? { model: effectiveModel } : {}),
          },
          {
            onEvent: (payload) =>
              handleStreamEvent(payload.event, payload.data),
          },
        )
      : import('../hermes-api').then((m) =>
          m.streamChat(
            sessionId,
            {
              message: opts.prompt,
              ...(effectiveModel ? { model: effectiveModel } : {}),
            },
            {
              onEvent: (payload) =>
                handleStreamEvent(payload.event, payload.data),
            },
          ),
        )
  )
    .then(() => {
      streamSettled = true
    })
    .catch((error) => {
      streamSettled = true
      streamRejected = error
    })

  // Soft-deadline loop: tick until stream settles or hard/soft deadline elapses.
  // On timeout we deliberately do NOT abort the fetch — the gateway turn keeps
  // running so stranded harvest can pick up the finished reply later.
  while (!streamSettled) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      console.log(
        `[turn-executor] member=${opts.member.displayName} soft/hard deadline elapsed after ${Date.now() - startedAt}ms — stranding (stream left running)`,
      )
      // Detach: swallow late settle so it doesn't become an unhandled rejection.
      void streamPromise.catch(() => undefined)
      return {
        replyText: (completedText ?? replyAccum).trim(),
        streamError: streamError ?? 'stream timeout',
        timedOut: true,
      }
    }
    await Promise.race([
      streamPromise.then(() => undefined),
      sleep(Math.min(remaining, GROUP_TURN_POLL_MS)),
    ])
  }

  if (
    streamRejected &&
    !(
      streamRejected instanceof Error && /timeout/i.test(streamRejected.message)
    )
  ) {
    // Real stream failure (not our soft timeout).
    if (streamRejected instanceof Error) throw streamRejected
    throw new Error(String(streamRejected))
  }

  console.log(
    `[turn-executor] member=${opts.member.displayName} stream done in ${Date.now() - startedAt}ms`,
  )

  return {
    replyText: (completedText ?? replyAccum).trim(),
    streamError,
    timedOut: false,
  }
}

async function pickReplyFromSession(
  opts: TurnExecutorOptions,
  sessionId: string,
  profile: string | null,
  before: number,
  streamFallback: string,
): Promise<string> {
  try {
    const client =
      opts.member.runtime === 'hermes' && profile
        ? getHermesApiClient(profile)
        : undefined
    const messages = client
      ? await client.getMessages(sessionId)
      : await getMessages(sessionId)
    const picked = pickGroupTurnReply(
      messages.map((m) => ({ role: m.role, content: m.content })),
      before,
    )
    if (picked && !isGroupPassText(picked)) return picked
    if (picked) return picked
  } catch (error) {
    console.warn(
      `[turn-executor] member=${opts.member.displayName} session pick failed:`,
      error instanceof Error ? error.message : String(error),
    )
  }
  return streamFallback
}

async function toTurnResult(
  opts: TurnExecutorOptions,
  sessionId: string,
  profile: string | null,
  before: number,
  capture: StreamCapture,
): Promise<GroupTurnResult> {
  console.log(
    `[turn-executor] member=${opts.member.displayName} replyText=${capture.replyText ? capture.replyText.slice(0, 80) : 'EMPTY'} timedOut=${capture.timedOut}`,
  )

  // Bot Mode: timeout → null/pass + stranded marker. Never post partial ack.
  if (capture.timedOut) {
    return { kind: 'timeout', before, sessionId }
  }

  const replyText = await pickReplyFromSession(
    opts,
    sessionId,
    profile,
    before,
    capture.replyText,
  )

  // Prefer streamError, but Hermes often materializes infra failures as
  // assistant content with no SSE error event — classify that text as failed
  // so the runner advances watermark without posting to the room.
  if (isGroupInfraFailureText(replyText) || isGroupInfraFailureText(capture.streamError)) {
    return {
      kind: 'failed',
      reason: (capture.streamError || replyText).slice(0, 500),
    }
  }

  if (replyText) {
    return isGroupPassText(replyText)
      ? { kind: 'pass' }
      : { kind: 'reply', text: replyText }
  }

  return {
    kind: 'failed',
    reason:
      capture.streamError ?? 'empty reply (no assistant content in stream)',
  }
}

async function executeHermesMemberTurn(
  opts: TurnExecutorOptions,
): Promise<GroupTurnResult> {
  // getOrCreateSession ensures the profile gateway before verifying/creating
  // the session — do not call ensureProfileGateway again here (avoids a second
  // health probe on every turn).
  let { sessionId, profile } = await getOrCreateSession(
    opts.roomId,
    opts.member,
    {
      dbPath: opts.dbPath,
      // Do NOT override title here — let agent-session-manager use its own
      // deterministic groupSessionTitle(roomId, participantId) so each member
      // gets a unique session and they never conflict.
    },
  )

  console.log(
    `[turn-executor] member=${opts.member.displayName} profile=${profile ?? 'n/a'} session=${sessionId}`,
  )

  try {
    // Baseline message count before submit — harvest/pick scan from here.
    let before = 0
    try {
      const client =
        opts.member.runtime === 'hermes' && profile
          ? getHermesApiClient(profile)
          : undefined
      const pre = client
        ? await client.getMessages(sessionId)
        : await getMessages(sessionId)
      before = pre.length
    } catch {
      before = 0
    }

    let capture = await streamOnce(opts, sessionId, profile)

    // Poisoned sessions (persisted model, often has_model_config=false) fail
    // instantly with this error. Retire and retry once on a bare session.
    if (
      !capture.replyText &&
      !capture.timedOut &&
      capture.streamError &&
      PROVIDER_CONFIG_RE.test(capture.streamError)
    ) {
      console.warn(
        `[turn-executor] member=${opts.member.displayName} retiring poisoned session ${sessionId} and retrying once`,
      )
      const client =
        opts.member.runtime === 'hermes' && profile
          ? getHermesApiClient(profile)
          : undefined
      forgetSession(opts.roomId, opts.member.participantId)
      await client?.deleteSession(sessionId).catch(() => undefined)

      const fresh = await getOrCreateSession(opts.roomId, opts.member, {
        dbPath: opts.dbPath,
      })
      sessionId = fresh.sessionId
      profile = fresh.profile
      console.log(
        `[turn-executor] member=${opts.member.displayName} retry session=${sessionId}`,
      )
      before = 0
      capture = await streamOnce(opts, sessionId, profile)
    }

    return await toTurnResult(opts, sessionId, profile, before, capture)
  } catch (error) {
    console.error(
      `[turn-executor] member=${opts.member.displayName} stream error:`,
      error,
    )
    return {
      kind: 'failed',
      reason:
        'submit failed: ' +
        (error instanceof Error ? error.message : String(error)),
    }
  }
}

export async function executeMemberTurn(
  opts: TurnExecutorOptions,
): Promise<GroupTurnResult> {
  if (!isHermesMember(opts.member)) {
    return executeManagedMemberTurn(opts)
  }
  return executeHermesMemberTurn(opts)
}
