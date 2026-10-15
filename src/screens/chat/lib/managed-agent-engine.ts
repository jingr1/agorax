import {
  createAgentSessionEngine,
  normalizeAgentActivitySession,
  selectEngineActiveTurn,
  selectEngineLatestTurn,
  selectEngineInteractionsForSession,
  selectEngineSession,
  selectSessionMessages,
  type AgentActivityMessage,
  type AgentActivitySendInputResult,
  type AgentActivitySession,
  type AgentActivitySessionDetailSnapshot,
  type AgentActivitySubmitInteractiveResult,
  type AgentActivityTurnCancelResponse,
  type AgentSessionActivateEffectResult,
  type AgentSessionEngine,
  type AgentSessionEngineState,
  type EngineEffectOptions,
  type EngineExtensionCommand,
  type EngineTypedCommandPort,
} from '@agorax/agent-activity-core'
import {
  mapManagedAgentActivitySnapshot,
  type ManagedAgentActivityDetail,
} from './managed-agent-activity-mapper'
import { projectPendingApprovalsFromToolCallMessages } from './managed-agent-interactions'
import {
  managedAgentActivateResponseFromJson,
  managedAgentCancelResponseFromJson,
  managedAgentDaemonCancelStateFromResult,
  managedAgentErrorMessageFromResponse,
  managedAgentInputResponseFromJson,
  managedAgentInteractionResponseFromJson,
} from '@/lib/managed-agent-runtime/command-dtos'
import {
  projectActivityMessagesToChat,
  selectAssistantStreamingMessageId,
} from './activity-list-projection'
import { applyOpenAssistantStreamingChrome } from './engine-open-assistant-stream'
import { ingestEngineUserPromptMessage } from './engine-user-prompt-ingest'
import {
  activityMessageToChatMessage,
  systemNoticeText,
  visibleErrorText,
} from './activity-message-mapper'

export {
  activityMessageToChatMessage,
  selectAssistantStreamingMessageId as selectManagedStreamingMessageId,
}

/**
 * Diff composer picks against the live session settings. Returns null when
 * nothing changed so submit can skip the settings write.
 */
export function managedSessionSettingsPatch(input: {
  selectedModel?: string | null
  effort?: string | null
  current?: {
    model?: string | null
    reasoningEffort?: string | null
  } | null
}): { model?: string; reasoningEffort?: string } | null {
  const patch: { model?: string; reasoningEffort?: string } = {}
  const selectedModel = input.selectedModel?.trim()
  if (selectedModel && selectedModel !== (input.current?.model ?? null)) {
    patch.model = selectedModel
  }
  const effort = input.effort?.trim()
  if (effort && effort !== (input.current?.reasoningEffort ?? null)) {
    patch.reasoningEffort = effort
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function createManagedAgentEngine(input: {
  workspaceId: string
  agentId?: string
  commandPort: EngineTypedCommandPort
}): AgentSessionEngine {
  return createAgentSessionEngine({
    identity: {
      workspaceId: input.workspaceId,
      origin: 'AGORAX_MANAGED_CHAT',
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

export function createManagedAgentCommandPort(
  agentId: string,
  onActivity: (detail: ManagedAgentActivityDetail) => void,
  options?: {
    displaySessionId?: () => string
    onRunStarted?: (runId: string, detail: ManagedAgentActivityDetail) => void
    /** Host-owned extension commands (session/reconcile, engine/reconcileWorkspace). */
    executeExtensionCommand?: (
      command: EngineExtensionCommand,
      options?: EngineEffectOptions,
    ) => Promise<unknown>
  },
): EngineTypedCommandPort {
  const request = async (
    path: string,
    body?: unknown,
    method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  ): Promise<unknown> => {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        managedAgentErrorMessageFromResponse(payload) ??
          `Managed Agent request failed: ${response.status}`,
      )
    }
    return payload
  }
  const unavailable = async (): Promise<never> => { throw new Error('Unsupported Managed Agent command') }
  const mapActivitySession = async (
    agentSessionId: string,
    activityPayload: unknown,
  ) => {
    const detail = mapManagedAgentActivitySnapshot(activityPayload)
    if (!detail) throw new Error('Managed Agent mutation returned an invalid snapshot')
    onActivity(detail)
    const session = detail.session
    if (session.agentSessionId !== agentSessionId && !session.agentSessionId) {
      throw new Error('Managed Agent mutation returned no session')
    }
    return { detail, session }
  }
  return {
    kind: 'typed',
    effects: {
      activateSession: async (input): Promise<AgentSessionActivateEffectResult> => {
        if (input.mode !== 'new') {
          // The workspace activate route only creates sessions; attaching to an
          // existing session is a read-side hydrate (detail + reconcile).
          throw new Error('Managed Agent activation supports mode "new" only')
        }
        const response = managedAgentActivateResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/engine/activate`, {
            displaySessionId: options?.displaySessionId?.() ?? input.agentSessionId,
            agentSessionId: input.agentSessionId,
            message: input.initialDisplayPrompt ?? '',
            promptContent: input.initialContent,
            ...(input.settings?.model ? { model: input.settings.model } : {}),
            ...(input.settings?.reasoningEffort
              ? { reasoningEffort: input.settings.reasoningEffort }
              : {}),
          }),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent activation returned an invalid snapshot')
        onActivity(detail)
        options?.onRunStarted?.(response.runId, detail)
        return {
          activation: { mode: 'new', status: 'attached' },
          session: detail.session,
        }
      },
      deleteSessions: async (input) => {
        const removedSessionIds: string[] = []
        for (const agentSessionId of input.agentSessionIds) {
          await request(
            `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(agentSessionId)}`,
            undefined,
            'DELETE',
          )
          removedSessionIds.push(agentSessionId)
        }
        return {
          removedSessionIds,
          removedSessions: removedSessionIds.length,
          removedMessages: 0,
          cleanupFailedSessionIds: [],
        }
      },
      renameSession: async (input) => {
        const payload = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/title`,
          { title: input.title },
          'PATCH',
        )
        const activity =
          payload && typeof payload === 'object' && 'activity' in payload
            ? (payload as { activity: unknown }).activity
            : null
        const { session } = await mapActivitySession(input.agentSessionId, activity)
        return { session }
      },
      setSessionPinned: async (input) => {
        const payload = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/pin`,
          { pinned: input.pinned },
        )
        const activity =
          payload && typeof payload === 'object' && 'activity' in payload
            ? (payload as { activity: unknown }).activity
            : null
        const { session } = await mapActivitySession(input.agentSessionId, activity)
        return { session }
      },
      updateSessionSettings: async (input) => {
        // Engine validates settings results with requireTopLevelSessionId —
        // returning `{}` marks the update "unknown" and blocks the prompt
        // queue. Mirror rename/pin: map activity and return scoped session.
        const payload = await request(
          `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/settings`,
          {
            ...(input.settings.model ? { model: input.settings.model } : {}),
            ...(input.settings.reasoningEffort
              ? { reasoningEffort: input.settings.reasoningEffort }
              : {}),
          },
        )
        const activity =
          payload && typeof payload === 'object' && 'activity' in payload
            ? (payload as { activity: unknown }).activity
            : null
        const { session } = await mapActivitySession(input.agentSessionId, activity)
        return { agentSessionId: input.agentSessionId, session }
      },
      sendInput: async (input): Promise<AgentActivitySendInputResult> => {
        const response = managedAgentInputResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/input`, {
            clientSubmitId: input.clientSubmitId,
            content: input.displayPrompt ?? '',
            promptContent: input.content,
          }),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent send returned an invalid snapshot')
        onActivity(detail)
        const turn = detail.turns.find((candidate) => candidate.turnId === detail.session.activeTurnId)
          ?? detail.session.latestTurn
        if (!turn) throw new Error('Managed Agent send returned no canonical turn')
        return { kind: 'turn', session: detail.session, turnId: turn.turnId, turn }
      },
      cancelTurn: async (input): Promise<AgentActivityTurnCancelResponse> => {
        const response = managedAgentCancelResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(input.agentSessionId)}/turns/${encodeURIComponent(input.turnId)}/cancel`),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent cancel returned an invalid snapshot')
        onActivity(detail)
        const turn = detail.turns.find((candidate) => candidate.turnId === input.turnId) ?? null
        const state = managedAgentDaemonCancelStateFromResult(response.result)
        if (state === 'not_found') {
          return { cancel: { canceled: false, reason: 'not_found' } }
        }
        if (state === 'settled') {
          // The provider already confirmed the canceled terminal; the snapshot
          // may lag, so project the canonical settlement explicitly.
          return {
            cancel: { canceled: true, reason: 'turn_canceled' },
            ...(turn ? { turn: { ...turn, phase: 'settled', outcome: 'canceled' as const } } : {}),
          }
        }
        if (state === 'already_settled') {
          return {
            cancel: { canceled: false, reason: 'already_settled' },
            ...(turn ? { turn } : {}),
          }
        }
        if (state === 'requested') {
          // Durable intent accepted; canonical settlement arrives via events /
          // reconcile, so the turn projects as settling, never as canceled.
          return {
            cancel: { canceled: false, reason: 'cancel_requested' },
            ...(turn ? { turn: { ...turn, phase: 'settling' as const, outcome: null } } : {}),
          }
        }
        // Daemon result carried no usable state: derive the response from the
        // snapshot, keeping the same canonical projections.
        if (!turn) return { cancel: { canceled: false, reason: 'not_found' } }
        if (turn.phase === 'settled') {
          return turn.outcome === 'canceled'
            ? { cancel: { canceled: true, reason: 'turn_canceled' }, turn }
            : { cancel: { canceled: false, reason: 'already_settled' }, turn }
        }
        return {
          cancel: { canceled: false, reason: 'cancel_requested' },
          turn: { ...turn, phase: 'settling' as const, outcome: null },
        }
      },
      respondToInteraction: async (input): Promise<AgentActivitySubmitInteractiveResult> => {
        const response = managedAgentInteractionResponseFromJson(
          await request(`/api/agents/${encodeURIComponent(agentId)}/interactions/${encodeURIComponent(input.agentSessionId)}/${encodeURIComponent(input.turnId)}/${encodeURIComponent(input.requestId)}`,
          { ...(input.action ? { action: input.action } : {}), ...(input.optionId ? { optionId: input.optionId } : {}), ...(input.payload ? { payload: input.payload } : {}) }),
        )
        const detail = mapManagedAgentActivitySnapshot(response.activity)
        if (!detail) throw new Error('Managed Agent interaction returned an invalid snapshot')
        onActivity(detail)
        return { session: detail.session }
      },
    },
    executePlanDecision: async (command) => {
      const payload = await request(
        `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(command.agentSessionId)}/turns/${encodeURIComponent(command.turnId)}/plan-decisions/${encodeURIComponent(command.requestId)}`,
        {
          promptKind: command.promptKind,
          action: command.action,
          idempotencyKey: command.idempotencyKey,
        },
      )
      const operation =
        payload &&
        typeof payload === 'object' &&
        'result' in payload &&
        (payload as { result?: { operation?: Record<string, unknown> } }).result
          ?.operation
          ? (payload as { result: { operation: Record<string, unknown> } }).result
              .operation
          : payload &&
              typeof payload === 'object' &&
              'result' in payload &&
              (payload as { result?: Record<string, unknown> }).result
            ? (payload as { result: Record<string, unknown> }).result
            : null
      if (!operation || typeof operation !== 'object') {
        throw new Error('Managed Agent plan decision returned no operation')
      }
      const activity =
        payload && typeof payload === 'object' && 'activity' in payload
          ? (payload as { activity: unknown }).activity
          : null
      if (activity) {
        const detail = mapManagedAgentActivitySnapshot(activity)
        if (detail) onActivity(detail)
      }
      const statusRaw = String(
        (operation as { Status?: unknown; status?: unknown }).Status ??
          (operation as { status?: unknown }).status ??
          'completed',
      ).toLowerCase()
      const status =
        statusRaw === 'prepared' ||
        statusRaw === 'leased' ||
        statusRaw === 'completed' ||
        statusRaw === 'failed'
          ? statusRaw
          : 'completed'
      return {
        operation: {
          agentSessionId: command.agentSessionId,
          idempotencyKey: command.idempotencyKey,
          operationId: String(
            (operation as { OperationID?: unknown; operationId?: unknown })
              .OperationID ??
              (operation as { operationId?: unknown }).operationId ??
              command.commandId,
          ),
          requestId: command.requestId,
          status,
          turnId: command.turnId,
          workspaceId: command.workspaceId,
          result:
            typeof (operation as { Result?: unknown }).Result === 'string'
              ? ((operation as { Result: string }).Result as string)
              : typeof (operation as { result?: unknown }).result === 'string'
                ? ((operation as { result: string }).result as string)
                : null,
          error:
            typeof (operation as { LastError?: unknown }).LastError === 'string'
              ? ((operation as { LastError: string }).LastError as string)
              : typeof (operation as { error?: unknown }).error === 'string'
                ? ((operation as { error: string }).error as string)
                : null,
        },
      }
    },
    execute: options?.executeExtensionCommand
      ? (command, effectOptions) => options.executeExtensionCommand!(command, effectOptions)
      : unavailable,
  }
}

export {
  managedAgentTargetId,
} from '@/lib/managed-agent-runtime/agent-targets'

export function createManagedSessionSkeleton(input: {
  workspaceId: string
  agentSessionId: string
  agentTargetId?: string
  title?: string
  nowUnixMs?: number
}): AgentActivitySession {
  const now = input.nowUnixMs ?? Date.now()
  return normalizeAgentActivitySession({
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    provider: 'managed',
    providerSessionId: input.agentSessionId,
    agentTargetId: input.agentTargetId?.trim() || 'managed',
    cwd: '',
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

/**
 * Same send-time shell as Hermes (`ingestEngineUserPromptMessage`).
 * Call before `submitPrompt` / activate-with-initial with the same clientSubmitId.
 */
export function ingestManagedUserPromptMessage(input: {
  engine: AgentSessionEngine
  workspaceId: string
  agentSessionId: string
  clientSubmitId: string
  text: string
  occurredAtUnixMs?: number
  agentTargetId?: string
}): void {
  ingestEngineUserPromptMessage({
    engine: input.engine,
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    clientSubmitId: input.clientSubmitId,
    text: input.text,
    occurredAtUnixMs: input.occurredAtUnixMs,
    ensureSession: ({ workspaceId, agentSessionId }) => {
      const now = Date.now()
      input.engine.dispatch({
        type: 'session/detailSnapshotReceived',
        workspaceId,
        session: createManagedSessionSkeleton({
          workspaceId,
          agentSessionId,
          agentTargetId: input.agentTargetId,
          nowUnixMs: now,
        }),
        childSessions: [],
        turns: [],
        messages: [],
        observedAtUnixMs: now,
      })
    },
  })
}

export function hydrateManagedAgentEngine(
  engine: AgentSessionEngine,
  detail: ManagedAgentActivityDetail,
): void {
  engine.dispatch({
    type: 'session/detailSnapshotReceived',
    workspaceId: detail.workspaceId,
    session: detail.session,
    childSessions: [],
    turns: detail.turns,
    messages: detail.messages,
    observedAtUnixMs: detail.session.updatedAtUnixMs,
  })
  for (const interaction of detail.interactions) {
    engine.dispatch({ type: 'interaction/upserted', interaction })
  }
  // Kimi (and other deferred ACP approvals) may leave waiting_approval tool
  // rows without interaction.requested. Upsert synthesized pending cards so
  // submitInteractionResponse can admit the click (engine requires pending).
  syncPendingApprovalsIntoEngine(engine, detail.messages, detail.interactions)
}

/**
 * Upserts pending approval Interactions derived from waiting_approval tool_call
 * messages when the daemon has not yet (or never) published interaction.requested.
 * Idempotent against already-pending rows.
 */
export function syncPendingApprovalsIntoEngine(
  engine: AgentSessionEngine,
  messages: readonly AgentActivityMessage[],
  existingInteractions?: readonly import('@agorax/agent-activity-core').AgentActivityInteraction[],
): void {
  const known =
    existingInteractions ??
    selectEngineInteractionsForSession(
      engine.getSnapshot(),
      messages[0]?.agentSessionId ?? null,
    )
  const synthesized = projectPendingApprovalsFromToolCallMessages(
    messages,
    known,
  )
  for (const interaction of synthesized) {
    if (known.some(
      (item) =>
        item.turnId === interaction.turnId &&
        item.requestId === interaction.requestId,
    )) {
      continue
    }
    engine.dispatch({ type: 'interaction/upserted', interaction })
  }
}

/**
 * Hydrates one projection-qualified core detail snapshot (the
 * `session/detail` route payload) without message history; the reconcile
 * executor owns message hydration via `afterVersion` pagination.
 */
export function hydrateManagedAgentSessionDetail(
  engine: AgentSessionEngine,
  detail: AgentActivitySessionDetailSnapshot,
): void {
  engine.dispatch({
    type: 'session/detailSnapshotReceived',
    workspaceId: detail.session.workspaceId,
    session: detail.session,
    childSessions: [...detail.childSessions],
    editRetry: detail.editRetry,
    turns: [...detail.turns],
    observedAtUnixMs: detail.session.updatedAtUnixMs,
  })
}

export function subscribeManagedAgentEngine(
  engine: AgentSessionEngine,
  listener: () => void,
): () => void {
  return engine.subscribe(() => listener())
}

export function selectManagedAgentChatState(
  state: AgentSessionEngineState,
  agentSessionId: string | null,
  options?: {
    /**
     * Optimistic / live overlay messages from
     * `coordinator.project(projectSnapshot(engineState))`. Engine selectors
     * still own turns/interactions; only the message lane is overridable.
     */
    sessionMessages?: readonly AgentActivityMessage[]
    /**
     * True while a submit intent is still requested/uncertain. Only lights the
     * empty-gap pill before any trailing assistant host content exists.
     */
    isSubmitting?: boolean
  },
) {
  const sessionMessages =
    options?.sessionMessages ??
    (agentSessionId ? selectSessionMessages(state, agentSessionId) : [])
  const latestTurn = selectEngineLatestTurn(state, agentSessionId)
  const projectedActiveTurn = selectEngineActiveTurn(state, agentSessionId)
  const activeTurn = projectedActiveTurn &&
    latestTurn?.turnId === projectedActiveTurn.turnId &&
    latestTurn.phase === 'settled'
    ? null
    : projectedActiveTurn
  const terminalTurn = activeTurn ?? latestTurn
  const visibleError = sessionMessages.find((message) =>
    message.role === 'assistant' &&
    message.kind === 'text' &&
    message.payload.kind === 'agent_visible_error' &&
    visibleErrorText(message.payload).length > 0,
  )
  const providerNotice = sessionMessages.find((message) =>
    message.role === 'assistant' &&
    message.kind === 'text' &&
    message.payload.kind === 'agent_system_notice' &&
    systemNoticeText(message.payload).length > 0,
  )
  const terminalError = terminalTurn?.phase === 'settled' && terminalTurn.outcome === 'failed'
    ? terminalTurn.error?.message ?? null
    : null
  const turnActive = activeTurn !== null && activeTurn.phase !== 'settled'
  const submitting = options?.isSubmitting === true
  const activityStreamingId = turnActive
    ? selectAssistantStreamingMessageId(sessionMessages, activeTurn.turnId)
    : null
  // Homologous with selectHermesChatState — pending shell + foldOpenTurn.
  const chrome = applyOpenAssistantStreamingChrome({
    messages: projectActivityMessagesToChat(
      sessionMessages,
      activityStreamingId,
    ),
    activityStreamingId,
    turnActive,
    submitting,
  })
  return {
    messages: chrome.messages,
    activeTurn,
    latestTurn,
    fileChanges: latestTurn?.fileChanges ?? null,
    usage: agentSessionId
      ? selectEngineSession(state, agentSessionId)?.usage ?? null
      : null,
    sessionTitle: agentSessionId
      ? selectEngineSession(state, agentSessionId)?.title?.trim() || null
      : null,
    isStreaming: chrome.isStreaming,
    /** Busy for composer / list; Activity chrome lives on MessageItem. */
    turnBusy: chrome.turnBusy,
    /** Assistant message id that should receive live streaming chrome. */
    streamingMessageId: chrome.streamingMessageId,
    error: terminalError ??
      (visibleError
        ? visibleErrorText(visibleError.payload)
        : providerNotice && terminalTurn?.phase === 'settled'
          ? systemNoticeText(providerNotice.payload)
        : null),
    interactions: projectPendingApprovalsFromToolCallMessages(
      sessionMessages,
      selectEngineInteractionsForSession(state, agentSessionId),
    ),
    activeToolCalls: agentSessionId
      ? sessionMessages
          .filter((message) =>
            isToolCallKind(message.kind) &&
            !isTerminalToolStatus(message.status) &&
            // Approval rows are interaction cards, not completed tools.
            !isWaitingApprovalToolStatus(
              message.status,
              message.payload,
            )
          )
          .map((message) => ({
            id: message.messageId,
            name: toolNameFromPayload(message.payload),
            phase: normalizeActiveToolPhase(message.status),
            args: record(message.payload.input ?? message.payload.arguments),
          }))
      : [],
  }
}

function isWaitingApprovalToolStatus(
  status: string | null | undefined,
  payload: Record<string, unknown>,
): boolean {
  const resolved =
    (typeof status === 'string' && status.trim()) ||
    (typeof payload.status === 'string' && payload.status.trim()) ||
    ''
  if (
    resolved === 'waiting_approval' ||
    resolved === 'awaiting_approval' ||
    resolved === 'waiting_input'
  ) {
    return true
  }
  return payload.callType === 'approval'
}

function normalizeActiveToolPhase(status: string | null | undefined): string {
  const resolved = typeof status === 'string' ? status.trim() : ''
  if (
    resolved === 'waiting_approval' ||
    resolved === 'awaiting_approval' ||
    resolved === 'waiting_input' ||
    resolved === 'waiting'
  ) {
    return 'running'
  }
  return resolved || 'running'
}

// Daemon canonical kinds: "tool_call" (payload toolName/input); "tool" with
// name/arguments is the legacy shim shape kept for replayed durable rows.
function isToolCallKind(kind: string): boolean {
  return kind === 'tool_call' || kind === 'tool'
}

function isTerminalToolStatus(status: string | null | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'error'
  )
}

function toolNameFromPayload(payload: Record<string, unknown>): string {
  const toolName = firstNonEmptyString(payload.toolName, payload.name)
  return toolName ?? 'Tool'
}

function firstNonEmptyString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}