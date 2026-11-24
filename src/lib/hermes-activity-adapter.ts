/**
 * Hermes runtime adapter → unified Agent Activity events.
 *
 * Layering (see docs/hermes-native-bridge.md §2):
 *   Runtime (Hermes SSE) → this adapter → AgentSessionEngine contract
 *   Runtime (managed CLI) → daemon → same contract
 *
 * Pure translation only — no store, no UI, no fetch.
 */

import type { AgentActivityUpdatedEvent } from '@agorax/agent-activity-core'
import { assistantMessageIdForRun } from './chat-turn-identity'
import { isHermesDurableRunId } from './hermes-durable-run-id'
import {
  hermesApprovalToInteraction,
  isHermesApprovalRequestEvent,
  isHermesApprovalRespondedEvent,
  normalizeHermesApprovalPayload,
  resolveHermesApprovalChoice,
} from './hermes-approval'

export { isHermesDurableRunId } from './hermes-durable-run-id'

export type HermesSseEventName =
  | 'started'
  | 'chunk'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'done'
  | 'error'
  | string

export type HermesActivityAdapterContext = {
  workspaceId: string
  /** Engine / Agorax session id (not necessarily gateway session key). */
  agentSessionId: string
  /** Engine turn id for this send. */
  turnId: string
  /** Gateway / send-stream run id once known. */
  runId: string | null
  nowUnixMs?: () => number
}

export type HermesActivityAdapterState = {
  runId: string | null
  assistantMessageId: string | null
  thinkingMessageId: string | null
  /** Last full text seen (Hermes chunk is often fullReplace cumulative). */
  lastText: string
  lastThinking: string
}

export function createHermesActivityAdapterState(): HermesActivityAdapterState {
  return {
    runId: null,
    assistantMessageId: null,
    thinkingMessageId: null,
    lastText: '',
    lastThinking: '',
  }
}

function nowMs(ctx: HermesActivityAdapterContext): number {
  return ctx.nowUnixMs?.() ?? Date.now()
}

type EnsureIdsResult = {
  state: HermesActivityAdapterState
  /** First durable assistant host allocated this frame. */
  allocated: boolean
  /** Host reminted from a non-durable Stop token onto gateway run_*. */
  reminted: boolean
}

/**
 * Allocate / upgrade durable assistant ids.
 * Workspace Stop UUIDs are ignored for host identity; only Hermes durable
 * run ids mint `assistant:<runId>`. If a UUID shell was already locked (legacy
 * started frames), remint onto the first durable run_* and flush buffers.
 */
function ensureIds(
  ctx: HermesActivityAdapterContext,
  state: HermesActivityAdapterState,
  runId: string | null,
): EnsureIdsResult {
  const incoming = (runId ?? '').trim() || null
  const durableIncoming = isHermesDurableRunId(incoming) ? incoming : null
  const durableExisting = isHermesDurableRunId(state.runId) ? state.runId : null
  const resolvedRun = durableIncoming ?? durableExisting

  if (!resolvedRun) {
    // Keep buffering; processing pulse owns the face until gateway run_*.
    return { state, allocated: false, reminted: false }
  }

  const assistantMessageId = assistantMessageIdForRun(
    resolvedRun,
    ctx.agentSessionId,
  )
  const thinkingMessageId = `${assistantMessageId}:thinking`

  if (!state.assistantMessageId) {
    return {
      state: {
        ...state,
        runId: resolvedRun,
        assistantMessageId,
        thinkingMessageId,
      },
      allocated: true,
      reminted: false,
    }
  }

  if (state.assistantMessageId === assistantMessageId) {
    return {
      state: { ...state, runId: resolvedRun },
      allocated: false,
      reminted: false,
    }
  }

  // Legacy: started locked a Workspace UUID shell; upgrade to run_*.
  if (!isHermesDurableRunId(state.runId) && durableIncoming) {
    return {
      state: {
        ...state,
        runId: resolvedRun,
        assistantMessageId,
        thinkingMessageId,
      },
      allocated: false,
      reminted: true,
    }
  }

  return {
    state: { ...state, runId: durableExisting ?? state.runId },
    allocated: false,
    reminted: false,
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Translate one Hermes send-stream SSE frame into zero or more unified
 * activity events. Mutates adapter state for cumulative text/thinking.
 */
export function hermesSseToActivityEvents(
  ctx: HermesActivityAdapterContext,
  state: HermesActivityAdapterState,
  event: HermesSseEventName,
  data: Record<string, unknown>,
): {
  state: HermesActivityAdapterState
  events: Array<AgentActivityUpdatedEvent>
} {
  const occurredAtUnixMs = nowMs(ctx)
  const payloadRunId =
    readString(data.runId).trim() || readString(data.run_id).trim() || null
  let next = state
  const events: Array<AgentActivityUpdatedEvent> = []

  const base = {
    workspaceId: ctx.workspaceId,
    agentSessionId: ctx.agentSessionId,
  }

  /**
   * Mint/upgrade durable host; on first allocate or remint, seed the text
   * anchor and flush any thinking/text buffered before run_* arrived so
   * Activity paints during busy — not only after settle replace.
   */
  const adoptRunId = (runId: string | null): void => {
    const result = ensureIds(ctx, next, runId)
    next = result.state
    if (!result.allocated && !result.reminted) return
    if (!next.assistantMessageId) return
    events.push({
      ...base,
      eventType: 'message_delta',
      data: {
        ...base,
        messageId: next.assistantMessageId,
        turnId: ctx.turnId,
        role: 'assistant',
        kind: 'text',
        occurredAtUnixMs,
        content: { operation: 'set', value: next.lastText || '' },
        status: 'streaming',
      },
    })
    if (next.thinkingMessageId && next.lastThinking.trim()) {
      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: next.thinkingMessageId,
          turnId: ctx.turnId,
          role: 'assistant_thinking',
          kind: 'reasoning',
          occurredAtUnixMs,
          content: { operation: 'set', value: next.lastThinking },
          status: 'streaming',
        },
      })
    }
  }

  adoptRunId(payloadRunId)

  const turnUpdate = (
    phase: 'running' | 'settling' | 'settled',
    outcome: 'completed' | 'failed' | 'canceled' | 'interrupted' | null,
    errorMessage?: string,
  ): AgentActivityUpdatedEvent => {
    const ts = occurredAtUnixMs
    return {
      ...base,
      eventType: 'turn_update',
      data: {
        ...base,
        eventType: 'turn_update',
        occurredAtUnixMs: ts,
        // Tutti: settling keeps the turn active so fold/busy stay on until
        // commandPort finishes authoritative backfill → settled.
        activeTurnId: phase === 'settled' ? null : ctx.turnId,
        turn: {
          turnId: ctx.turnId,
          agentSessionId: ctx.agentSessionId,
          phase,
          origin: 'user_prompt',
          outcome,
          error: errorMessage ? { message: errorMessage } : null,
          fileChanges: null,
          completedCommand: null,
          startedAtUnixMs: ts,
          settledAtUnixMs: phase === 'settled' ? ts : null,
          updatedAtUnixMs: ts,
        },
      },
    } as AgentActivityUpdatedEvent
  }

  /** Apply done.message content parts onto the same host before settle phase. */
  const applyDoneMessageDeltas = (message: unknown): void => {
    if (!message || typeof message !== 'object') return
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      const type = readString(rec.type)
      if (type === 'thinking' || type === 'redacted_thinking') {
        const thinking =
          readString(rec.thinking) || readString(rec.text)
        if (!thinking.trim() || !next.thinkingMessageId) continue
        if (thinking === next.lastThinking) continue
        const hadThinking = next.lastThinking.length > 0
        let appendText = thinking
        if (thinking.startsWith(next.lastThinking)) {
          appendText = thinking.slice(next.lastThinking.length)
        }
        next = { ...next, lastThinking: thinking }
        if (!appendText) continue
        events.push({
          ...base,
          eventType: 'message_delta',
          data: {
            ...base,
            messageId: next.thinkingMessageId,
            turnId: ctx.turnId,
            role: 'assistant_thinking',
            kind: 'reasoning',
            occurredAtUnixMs,
            content: hadThinking
              ? { operation: 'append_text', text: appendText }
              : { operation: 'set', value: thinking },
            status: 'streaming',
          },
        })
        continue
      }
      if (type === 'text') {
        const text = readString(rec.text)
        if (!text.trim() || !next.assistantMessageId) continue
        if (text === next.lastText) continue
        const useSet =
          next.lastText.length === 0 || !text.startsWith(next.lastText)
        const appendText = useSet
          ? text
          : text.slice(next.lastText.length)
        next = { ...next, lastText: text }
        if (!appendText && !useSet) continue
        events.push({
          ...base,
          eventType: 'message_delta',
          data: {
            ...base,
            messageId: next.assistantMessageId,
            turnId: ctx.turnId,
            role: 'assistant',
            kind: 'text',
            occurredAtUnixMs,
            content: useSet
              ? { operation: 'set', value: text }
              : { operation: 'append_text', text: appendText },
            status: 'streaming',
          },
        })
      }
    }
  }

  switch (event) {
    case 'started': {
      // adoptRunId already seeded when started carries a durable run_*.
      // Workspace Stop UUIDs must not mint assistant:<uuid> shells.
      events.push(turnUpdate('running', null))
      break
    }

    case 'chunk':
    case 'assistant': {
      const fullReplace = data.fullReplace === true
      const incoming =
        readString(data.text) ||
        readString(data.delta) ||
        readString(data.content) ||
        readString(data.chunk)
      if (!incoming && event === 'chunk') break

      const hadText = next.lastText.length > 0
      let appendText = incoming
      let useSet = !hadText
      if (fullReplace || event === 'assistant') {
        if (incoming.startsWith(next.lastText)) {
          appendText = incoming.slice(next.lastText.length)
        } else if (incoming === next.lastText) {
          appendText = ''
        } else {
          // Non-prefix replace: full set (cannot append onto stale prefix).
          appendText = incoming
          useSet = true
        }
        next = { ...next, lastText: incoming }
      } else {
        next = { ...next, lastText: next.lastText + incoming }
      }

      // Buffer until durable run_* — flush via adoptRunId on a later frame.
      if ((!appendText && !useSet) || !next.assistantMessageId) break
      if (!appendText && useSet && !next.lastText) break

      // First body / non-prefix replace must use `set` so overlay can create
      // or replace the row without append_without_anchor.
      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: next.assistantMessageId,
          turnId: ctx.turnId,
          role: 'assistant',
          kind: 'text',
          occurredAtUnixMs,
          content: useSet
            ? { operation: 'set', value: next.lastText || appendText }
            : { operation: 'append_text', text: appendText },
          status: 'streaming',
        },
      })
      break
    }

    case 'thinking': {
      const thinking =
        readString(data.text) || readString(data.thinking)
      if (!thinking.trim()) break

      const prev = next.lastThinking
      const hadThinking = prev.length > 0
      let appendText = thinking
      if (thinking.startsWith(prev)) {
        appendText = thinking.slice(prev.length)
      } else if (thinking === prev) {
        appendText = ''
      } else {
        appendText = thinking
      }
      next = { ...next, lastThinking: thinking }
      if (!appendText) break
      // Buffer until durable run_* so mid-turn Activity is not lost.
      if (!next.thinkingMessageId) break

      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: next.thinkingMessageId,
          turnId: ctx.turnId,
          role: 'assistant_thinking',
          kind: 'reasoning',
          occurredAtUnixMs,
          content: hadThinking
            ? { operation: 'append_text', text: appendText }
            : { operation: 'set', value: thinking },
          status: 'streaming',
        },
      })
      break
    }

    case 'tool': {
      const name = readString(data.name).trim() || 'tool'
      const toolCallId =
        readString(data.toolCallId).trim() ||
        readString(data.tool_call_id).trim() ||
        `${next.runId || ctx.turnId}:${name}`
      const phase = readString(data.phase).trim() || 'calling'
      const terminal =
        phase === 'complete' ||
        phase === 'completed' ||
        phase === 'done' ||
        phase === 'result' ||
        phase === 'error'
      const status =
        phase === 'error' ? 'failed' : terminal ? 'completed' : 'running'

      events.push({
        ...base,
        eventType: 'message_delta',
        data: {
          ...base,
          messageId: `toolcall:${toolCallId}`,
          turnId: ctx.turnId,
          role: 'assistant',
          kind: 'tool_call',
          occurredAtUnixMs,
          status,
          payloadSet: {
            name,
            toolName: name,
            phase,
            input: data.args ?? undefined,
            output: typeof data.result === 'string' ? data.result : undefined,
            preview:
              typeof data.preview === 'string' ? data.preview : undefined,
          },
          ...(typeof data.result === 'string'
            ? {
                toolOutput: {
                  operation: 'set' as const,
                  text: data.result,
                },
              }
            : {}),
        },
      })
      break
    }

    case 'done': {
      const stateName = readString(data.state).trim() || 'complete'
      const failed =
        stateName === 'error' ||
        stateName === 'failed' ||
        typeof data.errorMessage === 'string'
      const interrupted =
        stateName === 'interrupted' || stateName === 'canceled'
      // Stamp any carried message body onto the live host before phase change.
      applyDoneMessageDeltas(data.message)
      // Terminalize live hosts so history reconcile can drop them once msg-*
      // canonical rows arrive. Streaming leftovers stayed beside msg-N and
      // absorbed the *next* turn's thinking above the new question.
      const terminalStatus = failed
        ? 'failed'
        : interrupted
          ? 'completed'
          : 'completed'
      if (next.assistantMessageId) {
        events.push({
          ...base,
          eventType: 'message_delta',
          data: {
            ...base,
            messageId: next.assistantMessageId,
            turnId: ctx.turnId,
            role: 'assistant',
            kind: 'text',
            occurredAtUnixMs,
            content: { operation: 'set', value: next.lastText },
            status: terminalStatus,
          },
        })
      }
      if (next.thinkingMessageId && next.lastThinking) {
        events.push({
          ...base,
          eventType: 'message_delta',
          data: {
            ...base,
            messageId: next.thinkingMessageId,
            turnId: ctx.turnId,
            role: 'assistant_thinking',
            kind: 'reasoning',
            occurredAtUnixMs,
            content: { operation: 'set', value: next.lastThinking },
            status: terminalStatus,
          },
        })
      }
      if (failed) {
        events.push(
          turnUpdate(
            'settled',
            'failed',
            typeof data.errorMessage === 'string'
              ? data.errorMessage
              : undefined,
          ),
        )
        break
      }
      if (interrupted) {
        events.push(
          turnUpdate(
            'settled',
            stateName === 'canceled' ? 'canceled' : 'interrupted',
          ),
        )
        break
      }
      // Tutti: success done enters settling; commandPort backfills then settles.
      events.push(turnUpdate('settling', 'completed'))
      break
    }

    case 'error': {
      const message =
        readString(data.message) ||
        readString(data.errorMessage) ||
        'Hermes stream error'
      events.push(turnUpdate('settled', 'failed', message))
      break
    }

    case 'approval':
    case 'approval.request':
    case 'hermes.approval.request': {
      if (!isHermesApprovalRequestEvent(event, data)) break
      const normalized = normalizeHermesApprovalPayload(data, next.runId)
      if (!normalized) break
      if (normalized.runId) {
        adoptRunId(normalized.runId)
      }
      const interaction = hermesApprovalToInteraction({
        workspaceId: ctx.workspaceId,
        agentSessionId: ctx.agentSessionId,
        turnId: ctx.turnId,
        approval: normalized,
        status: 'pending',
        nowUnixMs: occurredAtUnixMs,
      })
      events.push({
        ...base,
        eventType: 'interaction_update',
        data: {
          ...base,
          eventType: 'interaction_update',
          occurredAtUnixMs,
          interaction,
        },
      })
      break
    }

    case 'approval.responded':
    case 'hermes.approval.responded': {
      if (!isHermesApprovalRespondedEvent(event, data)) break
      const normalized = normalizeHermesApprovalPayload(data, next.runId)
      if (!normalized) break
      const choice = resolveHermesApprovalChoice({
        optionId: readString(data.choice),
        action: readString(data.choice),
      })
      const interaction = hermesApprovalToInteraction({
        workspaceId: ctx.workspaceId,
        agentSessionId: ctx.agentSessionId,
        turnId: ctx.turnId,
        approval: normalized,
        status: 'answered',
        choice,
        nowUnixMs: occurredAtUnixMs,
      })
      events.push({
        ...base,
        eventType: 'interaction_update',
        data: {
          ...base,
          eventType: 'interaction_update',
          occurredAtUnixMs,
          interaction,
        },
      })
      break
    }

    default: {
      // Gateway may put the event name only inside the JSON payload.
      if (isHermesApprovalRequestEvent(event, data)) {
        return hermesSseToActivityEvents(ctx, state, 'approval', data)
      }
      if (isHermesApprovalRespondedEvent(event, data)) {
        return hermesSseToActivityEvents(
          ctx,
          state,
          'approval.responded',
          data,
        )
      }
      break
    }
  }

  return { state: next, events }
}
