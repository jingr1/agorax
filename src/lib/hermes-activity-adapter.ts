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
import {
  hermesApprovalToInteraction,
  isHermesApprovalRequestEvent,
  isHermesApprovalRespondedEvent,
  normalizeHermesApprovalPayload,
  resolveHermesApprovalChoice,
} from './hermes-approval'

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

function ensureIds(
  ctx: HermesActivityAdapterContext,
  state: HermesActivityAdapterState,
  runId: string | null,
): HermesActivityAdapterState {
  const resolvedRun = (runId ?? state.runId ?? '').trim() || null
  const assistantMessageId =
    state.assistantMessageId ??
    (resolvedRun
      ? assistantMessageIdForRun(resolvedRun, ctx.agentSessionId)
      : assistantMessageIdForRun(null, ctx.agentSessionId, ctx.turnId))
  const thinkingMessageId =
    state.thinkingMessageId ?? `${assistantMessageId}:thinking`
  return {
    ...state,
    runId: resolvedRun ?? state.runId,
    assistantMessageId,
    thinkingMessageId,
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
  let next = ensureIds(ctx, state, payloadRunId)
  const events: Array<AgentActivityUpdatedEvent> = []

  const base = {
    workspaceId: ctx.workspaceId,
    agentSessionId: ctx.agentSessionId,
  }

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
      next = ensureIds(ctx, next, payloadRunId)
      events.push(turnUpdate('running', null))
      // Seed overlay anchor so first chunk append is not rejected
      // (append_without_anchor). Empty set creates the durable assistant row.
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
            content: { operation: 'set', value: '' },
            status: 'streaming',
          },
        })
      }
      break
    }

    case 'chunk':
    case 'assistant': {
      next = ensureIds(ctx, next, payloadRunId)
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
      next = ensureIds(ctx, next, payloadRunId)
      const thinking =
        readString(data.text) || readString(data.thinking)
      if (!thinking.trim() || !next.thinkingMessageId) break

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
      next = ensureIds(ctx, next, payloadRunId)
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
      next = ensureIds(ctx, next, payloadRunId)
      const stateName = readString(data.state).trim() || 'complete'
      const failed =
        stateName === 'error' ||
        stateName === 'failed' ||
        typeof data.errorMessage === 'string'
      const interrupted =
        stateName === 'interrupted' || stateName === 'canceled'
      // Stamp any carried message body onto the live host before phase change.
      applyDoneMessageDeltas(data.message)
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
      next = ensureIds(ctx, next, payloadRunId)
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
      next = ensureIds(ctx, next, payloadRunId)
      if (!isHermesApprovalRequestEvent(event, data)) break
      const normalized = normalizeHermesApprovalPayload(data, next.runId)
      if (!normalized) break
      if (normalized.runId) {
        next = ensureIds(ctx, next, normalized.runId)
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
      next = ensureIds(ctx, next, payloadRunId)
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
