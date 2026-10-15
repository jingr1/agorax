/**
 * Hermes 1:1 AgentSessionEngine host — Phase C/D.
 *
 * Send/Stop go through commandPort → /api/send-stream + /api/runs/:id/stop.
 * SSE frames → hermesSseToActivityEvents → coordinator.ingestEvent.
 * Busy / open-turn projection: selectHermesChatState (Engine + overlay).
 */

import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  selectEngineActiveTurn,
  selectEngineInteractionsForSession,
  selectEngineLatestTurn,
  selectEngineSession,
  selectSessionMessages,
  type AgentActivityDurableMessage,
  type AgentActivityInteraction,
  type AgentActivityMessage,
  type AgentActivitySendInputResult,
  type AgentActivitySession,
  type AgentActivitySubmitInteractiveResult,
  type AgentActivityTurn,
  type AgentActivityTurnCancelResponse,
  type AgentActivityUpdatedEvent,
  type AgentSessionActivateEffectResult,
  type AgentSessionEngine,
  type AgentSessionEngineState,
  type EngineTypedCommandPort,
} from '@agorax/agent-activity-core'
import { assistantMessageIdForRun } from '@/lib/chat-turn-identity'
import {
  hermesHistoryMessagesToActivity,
  mergeHermesHistoryWithLiveByTurnIdentity,
} from '@/lib/hermes-history-to-activity'
import {
  projectActivityMessagesToChat,
  selectAssistantStreamingMessageId,
} from './activity-list-projection'
import { applyOpenAssistantStreamingChrome } from './engine-open-assistant-stream'
import { ingestEngineUserPromptMessage } from './engine-user-prompt-ingest'
import {
  systemNoticeText,
  visibleErrorText,
} from './activity-message-mapper'
import {
  assistantPlainTextFromHistoryMessage,
  hermesAssistantTextStampDelta,
  hermesSettledTurnUpdate,
  pickAuthoritativeAssistantText,
  shouldFetchHistoryForSettle,
  shouldStampAssistantText,
} from '@/lib/hermes-turn-settle-backfill'
import {
  createHermesActivityAdapterState,
  hermesSseToActivityEvents,
  type HermesActivityAdapterState,
  type HermesSseEventName,
} from '@/lib/hermes-activity-adapter'
import {
  hermesApprovalRespondBody,
  hermesApprovalToInteraction,
  resolveHermesApprovalChoice,
} from '@/lib/hermes-approval'
import { readResolvedSessionHeaders } from '@/lib/send-stream-session-headers'
import type { AgoraxRunMapping } from '@/server/agent-runtime/hermes-native-bridge'
import type { ChatMessage } from '../types'

export type HermesPendingSendOptions = {
  friendlyId?: string
  history?: Array<{ role: string; content: string }>
  thinking?: string
  fastMode?: boolean
  attachments?: unknown[]
  model?: string
}

export type HermesCommandPortOptions = {
  workspaceId: string
  profileName?: string | null
  /** Resolve mapping (memory cache + DB). */
  getMapping: (agentSessionId: string) => Promise<AgoraxRunMapping | null>
  /** Persist mapping after activate/send/cancel. */
  putMapping: (mapping: AgoraxRunMapping) => Promise<AgoraxRunMapping>
  /** Every translated activity event (coordinator.ingestEvent). */
  onActivityEvent: (event: AgentActivityUpdatedEvent) => void
  /** Extra send-stream fields stashed before submitPrompt. */
  takePendingSendOptions?: (
    clientSubmitId: string,
  ) => HermesPendingSendOptions | null
  /**
   * Optional legacy SSE side-channel for history/display write-through.
   * Must not be used as busy/settle authority.
   */
  onSseFrame?: (input: {
    agentSessionId: string
    event: HermesSseEventName
    data: Record<string, unknown>
  }) => void
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
  /** Notify UI waiters when sendInput finishes (success or throw). */
  onSendCompleted?: (clientSubmitId: string, error?: unknown) => void
  shouldPromoteResolvedSession?: (input: {
    requestedSessionKey: string
    resolvedSessionKey: string
  }) => boolean
}

function unavailable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`Unsupported Hermes command: ${name}`)
  }
}

function promptTextFromContent(
  content: ReadonlyArray<{ type?: string; text?: string }>,
): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n')
}

export function createHermesSessionSkeleton(input: {
  workspaceId: string
  agentSessionId: string
  title?: string
  providerSessionId?: string | null
  cwd?: string
  nowUnixMs?: number
}): AgentActivitySession {
  const now = input.nowUnixMs ?? Date.now()
  return normalizeAgentActivitySession({
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    provider: 'hermes',
    providerSessionId: input.providerSessionId ?? input.agentSessionId,
    agentTargetId: 'hermes-native',
    cwd: input.cwd ?? '',
    title: input.title?.trim() || 'Chat',
    activeTurnId: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
    startedAtUnixMs: now,
    lastEventUnixMs: now,
  })
}

function makeTurn(input: {
  agentSessionId: string
  turnId: string
  phase: AgentActivityTurn['phase']
  outcome?: AgentActivityTurn['outcome']
  errorMessage?: string
  nowUnixMs: number
}): AgentActivityTurn {
  return {
    agentSessionId: input.agentSessionId,
    turnId: input.turnId,
    phase: input.phase,
    origin: 'user_prompt',
    outcome: input.outcome ?? null,
    error: input.errorMessage ? { message: input.errorMessage } : null,
    startedAtUnixMs: input.nowUnixMs,
    settledAtUnixMs: input.phase === 'settled' ? input.nowUnixMs : null,
    updatedAtUnixMs: input.nowUnixMs,
  }
}

async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onFrame: (event: string, data: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const eventBlock of events) {
        if (!eventBlock.trim()) continue
        const lines = eventBlock.split('\n')
        let currentEvent = ''
        let currentData = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            currentData += line.slice(6)
          } else if (line.startsWith('data:')) {
            currentData += line.slice(5)
          }
        }
        if (!currentEvent || !currentData) continue
        try {
          const parsed = JSON.parse(currentData) as Record<string, unknown>
          await onFrame(currentEvent, parsed)
        } catch {
          // ignore malformed SSE
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

export function createHermesAgentEngine(input: {
  workspaceId: string
  commandPort: EngineTypedCommandPort
}): AgentSessionEngine {
  return createAgentSessionEngine({
    identity: {
      workspaceId: input.workspaceId,
      origin: 'AGORAX_HERMES_CHAT',
    },
    commandPort: input.commandPort,
    clock: { nowUnixMs: () => Date.now() },
    scheduler: {
      schedule(delayMs, task) {
        const timer = window.setTimeout(task, delayMs)
        return { cancel: () => window.clearTimeout(timer) }
      },
    },
  })
}

export function createHermesCommandPort(
  options: HermesCommandPortOptions,
): EngineTypedCommandPort {
  const profileName = options.profileName?.trim() || undefined
  /** approvalId → gateway run id (survives until respond / turn settle). */
  const approvalRunIds = new Map<string, string>()

  const persistMapping = async (
    partial: Partial<AgoraxRunMapping> & { agentSessionId: string },
  ): Promise<AgoraxRunMapping> => {
    const existing = await options.getMapping(partial.agentSessionId)
    const mapping: AgoraxRunMapping = {
      agentSessionId: partial.agentSessionId,
      turnId: partial.turnId ?? existing?.turnId ?? null,
      gatewaySessionId:
        partial.gatewaySessionId ?? existing?.gatewaySessionId ?? null,
      assignmentId: null,
      hermesRunId: partial.hermesRunId ?? existing?.hermesRunId ?? null,
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    }
    return options.putMapping(mapping)
  }

  return {
    kind: 'typed',
    effects: {
      activateSession: async (
        input,
      ): Promise<AgentSessionActivateEffectResult> => {
        if (input.mode !== 'new') {
          // Attach = hydrate existing gateway session; mapping must already exist
          // or we seed one keyed by agentSessionId === gatewaySessionId.
          const gatewaySessionId =
            (await options.getMapping(input.agentSessionId))
              ?.gatewaySessionId || input.agentSessionId
          const mapping = await persistMapping({
            agentSessionId: input.agentSessionId,
            gatewaySessionId,
            turnId: null,
            hermesRunId: null,
          })
          const session = createHermesSessionSkeleton({
            workspaceId: options.workspaceId,
            agentSessionId: input.agentSessionId,
            providerSessionId: mapping.gatewaySessionId,
            title: input.title,
          })
          return {
            activation: { mode: 'existing', status: 'already_attached' },
            detail: {
              projection: 'authoritative',
              lifecycleCapabilitiesProjected: false,
              session,
              childSessions: [],
              turns: [],
            },
            session,
          }
        }

        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileName,
            ...(input.title
              ? { title: input.title, friendlyId: input.title }
              : {}),
          }),
        })
        if (!res.ok) {
          throw new Error(
            (await res.text().catch(() => '')) ||
              `Hermes create session failed: ${res.status}`,
          )
        }
        const data = (await res.json()) as {
          sessionKey?: string
          friendlyId?: string
        }
        const gatewaySessionId =
          typeof data.sessionKey === 'string' ? data.sessionKey.trim() : ''
        if (!gatewaySessionId) {
          throw new Error('Hermes create session returned no sessionKey')
        }
        const agentSessionId = input.agentSessionId.trim() || gatewaySessionId
        await persistMapping({
          agentSessionId,
          gatewaySessionId,
          turnId: null,
          hermesRunId: null,
        })
        const friendlyId =
          typeof data.friendlyId === 'string' && data.friendlyId.trim()
            ? data.friendlyId.trim()
            : gatewaySessionId
        options.onSessionResolved?.({
          sessionKey: gatewaySessionId,
          friendlyId,
        })
        const session = createHermesSessionSkeleton({
          workspaceId: options.workspaceId,
          agentSessionId,
          providerSessionId: gatewaySessionId,
          title: input.title,
        })
        return {
          activation: { mode: 'new', status: 'attached' },
          session,
        }
      },

      sendInput: async (input): Promise<AgentActivitySendInputResult> => {
        const clientSubmitId = input.clientSubmitId.trim()
        try {
          const agentSessionId = input.agentSessionId.trim()
          const mapping = await options.getMapping(agentSessionId)
          const gatewaySessionId =
            mapping?.gatewaySessionId?.trim() || agentSessionId
          const turnId = `turn-${clientSubmitId || Date.now()}`
          const message =
            input.displayPrompt?.trim() ||
            promptTextFromContent(input.content) ||
            ''
          if (!message) {
            throw new Error('Hermes sendInput requires text content')
          }

          await persistMapping({
            agentSessionId,
            gatewaySessionId,
            turnId,
            hermesRunId: null,
          })

          // Same pending host as ingestHermesUserPromptMessage — started must
          // not mint a second assistant:<runId> row (duplicate bubbles).
          const pendingAssistantId = assistantMessageIdForRun(
            null,
            agentSessionId,
            clientSubmitId,
          )
          let adapter: HermesActivityAdapterState = {
            ...createHermesActivityAdapterState(),
            assistantMessageId: pendingAssistantId,
            thinkingMessageId: `${pendingAssistantId}:thinking`,
          }
          let hermesRunId: string | null = null
          let streamPhase: 'none' | 'settling' | 'settled' = 'none'
          let settledOutcome: AgentActivityTurn['outcome'] = null
          let settledError: string | undefined
          /** True when a success `done` carried body text (skip history stamp). */
          let doneCarriedFinalText = false
          const now = () => Date.now()

          const ingestFrame = async (
            event: HermesSseEventName,
            data: Record<string, unknown>,
          ) => {
            const payloadRun =
              (typeof data.runId === 'string' && data.runId.trim()) ||
              (typeof data.run_id === 'string' && data.run_id.trim()) ||
              null
            if (payloadRun) hermesRunId = payloadRun

            if (event === 'done') {
              const doneText = assistantPlainTextFromHistoryMessage(
                data.message as
                  | { role?: string; content?: unknown; text?: unknown }
                  | undefined,
              )
              if (doneText) doneCarriedFinalText = true
            }

            const ctx = {
              workspaceId: options.workspaceId,
              agentSessionId,
              turnId,
              runId: hermesRunId,
            }
            const { state: nextAdapter, events } = hermesSseToActivityEvents(
              ctx,
              adapter,
              event,
              data,
            )
            adapter = nextAdapter
            if (adapter.runId) hermesRunId = adapter.runId

            for (const activityEvent of events) {
              options.onActivityEvent(activityEvent)
              if (activityEvent.eventType === 'interaction_update') {
                const interaction = (
                  activityEvent.data as {
                    interaction?: AgentActivityInteraction
                  }
                ).interaction
                const approvalId = interaction?.requestId?.trim()
                const metaRun =
                  interaction?.metadata &&
                  typeof interaction.metadata === 'object' &&
                  typeof (interaction.metadata as { hermesRunId?: unknown })
                    .hermesRunId === 'string'
                    ? String(
                        (interaction.metadata as { hermesRunId: string })
                          .hermesRunId,
                      ).trim()
                    : ''
                if (approvalId && metaRun) {
                  approvalRunIds.set(approvalId, metaRun)
                }
              }
              if (activityEvent.eventType === 'turn_update') {
                const turn = (
                  activityEvent.data as {
                    turn?: {
                      phase?: string
                      outcome?: string | null
                      error?: { message?: string } | null
                    }
                  }
                ).turn
                if (turn?.phase === 'settling') {
                  streamPhase = 'settling'
                }
                if (turn?.phase === 'settled') {
                  streamPhase = 'settled'
                  settledOutcome =
                    (turn.outcome as AgentActivityTurn['outcome']) ??
                    'completed'
                  settledError = turn.error?.message ?? settledError
                }
              }
            }
            options.onSseFrame?.({ agentSessionId, event, data })
          }

          const pending =
            options.takePendingSendOptions?.(clientSubmitId) ?? null
          const response = await fetch('/api/send-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionKey: gatewaySessionId,
              friendlyId: pending?.friendlyId,
              message,
              history: pending?.history,
              thinking: pending?.thinking,
              fastMode: pending?.fastMode,
              attachments: pending?.attachments,
              idempotencyKey: clientSubmitId,
              model: pending?.model || undefined,
              profileName,
              locale:
                typeof window !== 'undefined'
                  ? localStorage.getItem('hermes-workspace-locale') || 'en'
                  : 'en',
            }),
            signal: input.signal,
          })

          if (!response.ok) {
            const errorText = await response.text().catch(() => '')
            const errMsg =
              errorText || `Hermes send-stream failed: ${response.status}`
            const failEvent = hermesSseToActivityEvents(
              {
                workspaceId: options.workspaceId,
                agentSessionId,
                turnId,
                runId: null,
              },
              adapter,
              'error',
              { message: errMsg },
            )
            adapter = failEvent.state
            for (const activityEvent of failEvent.events) {
              options.onActivityEvent(activityEvent)
            }
            throw new Error(errMsg)
          }

          const resolvedHeaders = readResolvedSessionHeaders(response.headers, {
            sessionKey: gatewaySessionId,
            friendlyId: gatewaySessionId,
          })
          const shouldPromote =
            options.shouldPromoteResolvedSession?.({
              requestedSessionKey: gatewaySessionId,
              resolvedSessionKey: resolvedHeaders.sessionKey,
            }) ??
            (gatewaySessionId === 'new' || gatewaySessionId === 'main')
          if (
            resolvedHeaders.sessionKey &&
            resolvedHeaders.sessionKey !== gatewaySessionId &&
            shouldPromote
          ) {
            await persistMapping({
              agentSessionId,
              gatewaySessionId: resolvedHeaders.sessionKey,
              turnId,
            })
            options.onSessionResolved?.({
              sessionKey: resolvedHeaders.sessionKey,
              friendlyId: resolvedHeaders.friendlyId,
            })
          }

          if (!response.body) {
            throw new Error('Hermes send-stream returned no body')
          }

          await parseSseStream(response.body, input.signal, ingestFrame)

          const resolvedGateway =
            (await options.getMapping(agentSessionId))?.gatewaySessionId ??
            gatewaySessionId

          if (hermesRunId) {
            await persistMapping({
              agentSessionId,
              gatewaySessionId: resolvedGateway,
              turnId,
              hermesRunId,
            })
          }

          const terminalFailed =
            streamPhase === 'settled' &&
            (settledOutcome === 'failed' ||
              settledOutcome === 'canceled' ||
              settledOutcome === 'interrupted')

          // Tutti: success path stays in settling until authoritative backfill,
          // then emits settled. Failures already settled from the adapter.
          if (!terminalFailed) {
            if (streamPhase === 'none') {
              const { state: nextAdapter, events } = hermesSseToActivityEvents(
                {
                  workspaceId: options.workspaceId,
                  agentSessionId,
                  turnId,
                  runId: hermesRunId,
                },
                adapter,
                'done',
                { state: 'complete', runId: hermesRunId },
              )
              adapter = nextAdapter
              for (const activityEvent of events) {
                options.onActivityEvent(activityEvent)
              }
              streamPhase = 'settling'
              settledOutcome = settledOutcome ?? 'completed'
            }

            // History stamp only when done.message did not carry final text
            // (avoid settle-path latency on the common complete path).
            if (
              shouldFetchHistoryForSettle({
                doneCarriedFinalText,
                liveText: adapter.lastText,
              })
            ) {
              try {
                const historySessionKey = resolvedGateway || agentSessionId
                const query = new URLSearchParams({
                  limit: '80',
                  sessionKey: historySessionKey,
                  friendlyId: historySessionKey,
                })
                if (profileName) query.set('profile', profileName)
                const historyRes = await fetch(
                  `/api/history?${query.toString()}`,
                  { signal: input.signal },
                )
                if (historyRes.ok) {
                  const historyJson = (await historyRes.json()) as {
                    messages?: Array<{
                      role?: string
                      content?: unknown
                      text?: unknown
                    }>
                  }
                  const authText = pickAuthoritativeAssistantText(
                    historyJson.messages ?? [],
                    0,
                  )
                  if (
                    shouldStampAssistantText(adapter.lastText, authText) &&
                    adapter.assistantMessageId
                  ) {
                    options.onActivityEvent(
                      hermesAssistantTextStampDelta({
                        workspaceId: options.workspaceId,
                        agentSessionId,
                        turnId,
                        messageId: adapter.assistantMessageId,
                        text: authText,
                        nowUnixMs: now(),
                      }),
                    )
                    adapter = { ...adapter, lastText: authText }
                  }
                }
              } catch {
                // Best-effort; settle even if history is unavailable.
              }
            }

            const settleTs = now()
            options.onActivityEvent(
              hermesSettledTurnUpdate({
                workspaceId: options.workspaceId,
                agentSessionId,
                turnId,
                outcome: settledOutcome ?? 'completed',
                errorMessage: settledError,
                nowUnixMs: settleTs,
              }),
            )
            streamPhase = 'settled'
            settledOutcome = settledOutcome ?? 'completed'
          }

          const ts = now()
          const turn = makeTurn({
            agentSessionId,
            turnId,
            phase: 'settled',
            outcome: settledOutcome,
            errorMessage: settledError,
            nowUnixMs: ts,
          })
          const session = createHermesSessionSkeleton({
            workspaceId: options.workspaceId,
            agentSessionId,
            providerSessionId: resolvedGateway,
            nowUnixMs: ts,
          })
          options.onSendCompleted?.(clientSubmitId)
          return { kind: 'turn', session, turnId, turn }
        } catch (error) {
          options.onSendCompleted?.(clientSubmitId, error)
          throw error
        }
      },

      cancelTurn: async (input): Promise<AgentActivityTurnCancelResponse> => {
        const agentSessionId = input.agentSessionId.trim()
        const mapping = await options.getMapping(agentSessionId)
        const hermesRunId = mapping?.hermesRunId?.trim() || null
        const gatewaySessionId =
          mapping?.gatewaySessionId?.trim() || agentSessionId
        const turnId = input.turnId.trim() || mapping?.turnId || `turn-cancel-${Date.now()}`
        const ts = Date.now()

        if (hermesRunId) {
          await fetch(`/api/runs/${encodeURIComponent(hermesRunId)}/stop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionKey: gatewaySessionId }),
            signal: input.signal,
          }).catch(() => {})
        } else if (gatewaySessionId) {
          await fetch(
            `/api/runs/${encodeURIComponent(`session:${gatewaySessionId}`)}/stop`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionKey: gatewaySessionId }),
              signal: input.signal,
            },
          ).catch(() => {})
        }

        const { events } = hermesSseToActivityEvents(
          {
            workspaceId: options.workspaceId,
            agentSessionId,
            turnId,
            runId: hermesRunId,
          },
          createHermesActivityAdapterState(),
          'done',
          { state: 'interrupted', runId: hermesRunId },
        )
        // Force canceled outcome via explicit turn_update if adapter mapped interrupted differently
        const cancelEvent: AgentActivityUpdatedEvent = {
          workspaceId: options.workspaceId,
          agentSessionId,
          eventType: 'turn_update',
          data: {
            workspaceId: options.workspaceId,
            agentSessionId,
            eventType: 'turn_update',
            occurredAtUnixMs: ts,
            activeTurnId: null,
            turn: {
              turnId,
              agentSessionId,
              phase: 'settled',
              origin: 'user_prompt',
              outcome: 'canceled',
              error: null,
              fileChanges: null,
              completedCommand: null,
              startedAtUnixMs: ts,
              settledAtUnixMs: ts,
              updatedAtUnixMs: ts,
            },
          },
        } as AgentActivityUpdatedEvent
        for (const activityEvent of events) {
          options.onActivityEvent(activityEvent)
        }
        options.onActivityEvent(cancelEvent)

        await persistMapping({
          agentSessionId,
          gatewaySessionId,
          turnId,
          hermesRunId,
        })

        const turn = makeTurn({
          agentSessionId,
          turnId,
          phase: 'settled',
          outcome: 'canceled',
          nowUnixMs: ts,
        })
        return {
          cancel: { canceled: true, reason: 'turn_canceled' },
          turn,
        }
      },

      deleteSessions: unavailable('deleteSessions'),
      renameSession: unavailable('renameSession'),
      setSessionPinned: unavailable('setSessionPinned'),
      updateSessionSettings: unavailable('updateSessionSettings'),
      respondToInteraction: async (
        input,
        effectOptions,
      ): Promise<AgentActivitySubmitInteractiveResult> => {
        const agentSessionId = input.agentSessionId.trim()
        const turnId = input.turnId.trim()
        const requestId = input.requestId.trim()
        if (!agentSessionId || !turnId || !requestId) {
          throw new Error('Hermes approval response requires session/turn/request ids')
        }

        const choice = resolveHermesApprovalChoice({
          optionId: input.optionId,
          action: input.action,
          payload: input.payload ?? null,
        })
        if (!choice) {
          throw new Error(
            'Hermes approval choice must be once|session|always|deny',
          )
        }

        const mapping = await options.getMapping(agentSessionId)
        const gatewaySessionId =
          mapping?.gatewaySessionId?.trim() || agentSessionId
        const hermesRunId =
          approvalRunIds.get(requestId)?.trim() ||
          mapping?.hermesRunId?.trim() ||
          ''
        if (!hermesRunId) {
          throw new Error(
            'No Hermes run id bound for this approval — wait for approval.request or retry',
          )
        }

        const response = await fetch(
          `/api/runs/${encodeURIComponent(hermesRunId)}/approval`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              hermesApprovalRespondBody({
                choice,
                approvalId: requestId,
                profileName,
              }),
            ),
            signal: effectOptions?.signal ?? input.signal,
          },
        )
        if (!response.ok) {
          const errorText = await response.text().catch(() => '')
          throw new Error(
            errorText ||
              `Hermes approval relay failed: ${response.status}`,
          )
        }

        const now = Date.now()
        const answered = hermesApprovalToInteraction({
          workspaceId: options.workspaceId,
          agentSessionId,
          turnId,
          approval: {
            approvalId: requestId,
            runId: hermesRunId,
            tool: 'terminal',
            command: '',
            description: 'Approval resolved',
            patternKey: '',
            patternKeys: [],
            riskLevel: 'high',
            choices: [choice],
            allowPermanent: choice === 'always',
            rawApprovalIdPresent: true,
          },
          status: 'answered',
          choice,
          nowUnixMs: now,
        })
        const activityEvent: AgentActivityUpdatedEvent = {
          workspaceId: options.workspaceId,
          agentSessionId,
          eventType: 'interaction_update',
          data: {
            workspaceId: options.workspaceId,
            agentSessionId,
            eventType: 'interaction_update',
            occurredAtUnixMs: now,
            interaction: answered,
          },
        }
        options.onActivityEvent(activityEvent)
        approvalRunIds.delete(requestId)

        const session = createHermesSessionSkeleton({
          workspaceId: options.workspaceId,
          agentSessionId,
          providerSessionId: gatewaySessionId,
          nowUnixMs: now,
        })
        return {
          session: {
            ...session,
            pendingInteractions: [],
            latestTurnInteractions: [answered],
          },
        }
      },
    },
    execute: unavailable('execute'),
  }
}

export function hydrateHermesAgentEngine(
  engine: AgentSessionEngine,
  session: AgentActivitySession,
): void {
  engine.dispatch({
    type: 'session/detailSnapshotReceived',
    workspaceId: session.workspaceId,
    session,
    childSessions: [],
    turns: session.activeTurn
      ? [session.activeTurn]
      : session.latestTurn
        ? [session.latestTurn]
        : [],
    messages: [],
    observedAtUnixMs: session.updatedAtUnixMs,
  })
}

export type HermesHistoryReconcileCoordinator = {
  reconcileAuthoritativeHistory: (
    agentSessionId: string,
    messages: readonly AgentActivityDurableMessage[],
    turns: readonly AgentActivityTurn[],
  ) => void
}

/**
 * Authoritative history → Engine message bucket + overlay (managed homology).
 * Call when history is idle (not mid-turn) so replace cannot wipe live rows.
 */
export function reconcileHermesHistoryIntoEngine(input: {
  engine: AgentSessionEngine
  coordinator: HermesHistoryReconcileCoordinator
  workspaceId: string
  agentSessionId: string
  historyMessages: readonly ChatMessage[]
  historyRevision?: number
  /**
   * Overlay projection (preferred). Live assistant deltas live here, not in
   * the Engine bucket — stale history must not wipe them.
   */
  projectedMessages?: readonly AgentActivityMessage[]
}): number {
  const agentSessionId = input.agentSessionId.trim()
  const workspaceId = input.workspaceId.trim() || 'default'
  if (!agentSessionId) return 0

  const existing = selectEngineSession(input.engine.getSnapshot(), agentSessionId)
  if (!existing) {
    hydrateHermesAgentEngine(
      input.engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId,
      }),
    )
  }
  const live = selectEngineSession(input.engine.getSnapshot(), agentSessionId)
  // historyAuthoritative requires iterable interaction arrays on session.
  const session = normalizeAgentActivitySession({
    ...(live ??
      createHermesSessionSkeleton({ workspaceId, agentSessionId })),
    latestTurnInteractions: live?.latestTurnInteractions ?? [],
    pendingInteractions: live?.pendingInteractions ?? [],
  })

  const historyMapped = hermesHistoryMessagesToActivity({
    workspaceId,
    agentSessionId,
    messages: input.historyMessages,
  })
  const current =
    input.projectedMessages ??
    selectSessionMessages(input.engine.getSnapshot(), agentSessionId)
  // Turn-ordinal identity stamp (contract §4): live owns messageId for the
  // paired turn; history fills older gaps / payload. Never append msg-N beside
  // assistant:<runId> for the same user-turn.
  const messages = mergeHermesHistoryWithLiveByTurnIdentity({
    workspaceId,
    agentSessionId,
    history: historyMapped,
    live: current,
  })
  const turns = [
    ...(session.activeTurn ? [session.activeTurn] : []),
    ...(session.latestTurn &&
    session.latestTurn.turnId !== session.activeTurn?.turnId
      ? [session.latestTurn]
      : []),
  ]
  const historyRevision =
    input.historyRevision ??
    Math.max(1, messages.reduce((max, row) => Math.max(max, row.version), 0))

  input.engine.dispatch({
    type: 'session/historyAuthoritativeSnapshotReceived',
    workspaceId,
    agentSessionId,
    session,
    childSessions: [],
    turns,
    messages,
    historyRevision,
  })
  input.coordinator.reconcileAuthoritativeHistory(
    agentSessionId,
    messages,
    turns,
  )
  return messages.length
}

/**
 * Optimistic user row + empty assistant host before SSE `started`.
 * Same turnId as commandPort send so later assistant:<runId> folds onto this host.
 */
export function ingestHermesUserPromptMessage(input: {
  engine: AgentSessionEngine
  workspaceId: string
  agentSessionId: string
  clientSubmitId: string
  text: string
  occurredAtUnixMs?: number
}): void {
  ingestEngineUserPromptMessage({
    ...input,
    ensureSession: ({ workspaceId, agentSessionId }) => {
      hydrateHermesAgentEngine(
        input.engine,
        createHermesSessionSkeleton({ workspaceId, agentSessionId }),
      )
    },
  })
}

/**
 * Hermes chat VM — same list fold as selectManagedAgentChatState
 * (projectActivityMessagesToChat). Approvals stay gateway-native.
 */
export function selectHermesChatState(
  state: AgentSessionEngineState,
  agentSessionId: string | null,
  options?: {
    sessionMessages?: readonly AgentActivityMessage[]
    isSubmitting?: boolean
  },
) {
  const sessionMessages =
    options?.sessionMessages ??
    (agentSessionId ? selectSessionMessages(state, agentSessionId) : [])
  const latestTurn = selectEngineLatestTurn(state, agentSessionId)
  const projectedActiveTurn = selectEngineActiveTurn(state, agentSessionId)
  const activeTurn =
    projectedActiveTurn &&
    latestTurn?.turnId === projectedActiveTurn.turnId &&
    latestTurn.phase === 'settled'
      ? null
      : projectedActiveTurn
  const turnActive = activeTurn !== null && activeTurn.phase !== 'settled'
  const submitting = options?.isSubmitting === true
  const activityStreamingId = turnActive
    ? selectAssistantStreamingMessageId(sessionMessages, activeTurn.turnId)
    : null
  const chrome = applyOpenAssistantStreamingChrome({
    messages: projectActivityMessagesToChat(
      sessionMessages,
      activityStreamingId,
    ),
    activityStreamingId,
    turnActive,
    submitting,
  })
  const terminalTurn = activeTurn ?? latestTurn
  const visibleError = sessionMessages.find(
    (message) =>
      message.role === 'assistant' &&
      message.kind === 'text' &&
      message.payload.kind === 'agent_visible_error' &&
      visibleErrorText(message.payload).length > 0,
  )
  const providerNotice = sessionMessages.find(
    (message) =>
      message.role === 'assistant' &&
      message.kind === 'text' &&
      message.payload.kind === 'agent_system_notice' &&
      systemNoticeText(message.payload).length > 0,
  )
  const terminalError =
    terminalTurn?.phase === 'settled' && terminalTurn.outcome === 'failed'
      ? terminalTurn.error?.message ?? null
      : null

  const interactions = agentSessionId
    ? selectEngineInteractionsForSession(state, agentSessionId).filter(
        (interaction) => interaction.status === 'pending',
      )
    : []

  return {
    messages: chrome.messages,
    activeTurn,
    latestTurn,
    sessionTitle: agentSessionId
      ? selectEngineSession(state, agentSessionId)?.title?.trim() || null
      : null,
    isStreaming: chrome.isStreaming,
    /** Busy for composer / list; Activity chrome lives on MessageItem. */
    turnBusy: chrome.turnBusy,
    streamingMessageId: chrome.streamingMessageId,
    error:
      terminalError ??
      (visibleError
        ? visibleErrorText(visibleError.payload)
        : providerNotice && terminalTurn?.phase === 'settled'
          ? systemNoticeText(providerNotice.payload)
          : null),
    /** Pending Hermes gateway approvals for ManagedAgentInteractionPanel. */
    interactions,
  }
}

/** Re-export for callers that need to join response settlement state. */
export type { AgentActivityInteraction }

/** @deprecated Use selectAssistantStreamingMessageId — same implementation. */
export const selectHermesStreamingMessageId = selectAssistantStreamingMessageId

/** @deprecated Use projectActivityMessagesToChat — same implementation. */
export const projectHermesActivityMessagesToChat = projectActivityMessagesToChat

