'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  clearManagedSessionMessages,
  fetchSessionsForAgent,
} from '@/lib/agent-api'
import { useAgentStore } from '@/stores/agent-store'
import {
  pendingSessionModelKey,
  useSessionModelStore,
} from '@/stores/session-model-store'
import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivitySessionDetailSnapshot,
  AgentSessionEngine,
  EngineEffectOptions,
  EngineExtensionCommand,
  EngineScheduler,
  EngineTypedCommandPort,
  InteractionResponseState,
  SessionReconcileCommand,
} from '@agorax/agent-activity-core'
import {
  canonicalInteractionKey,
  createAgentActivitySessionReconcileExecutor,
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineInteractionResponse,
  selectEngineInteractionsForSession,
  selectEngineSession,
  selectEngineSubmitAvailability,
  selectEngineVisibleQueuedPrompts,
  selectSessionIsSubmitting,
} from '@agorax/agent-activity-core'
import { writeLastSession } from '../last-session'
import type { ChatMessage } from '../types'
import {
  createManagedAgentCommandPort,
  createManagedAgentEngine,
  hydrateManagedAgentEngine,
  hydrateManagedAgentSessionDetail,
  ingestManagedUserPromptMessage,
  managedSessionSettingsPatch,
  selectManagedAgentChatState,
  subscribeManagedAgentEngine,
  syncPendingApprovalsIntoEngine,
} from '../lib/managed-agent-engine'
import { managedPromptContentFromAttachments } from '@/lib/managed-agent-runtime/prompt-content'
import { managedAgentTargetIdForRuntime } from '@/lib/managed-agent-runtime/agent-targets'
import {
  createManagedAgentEventBridge,
  type ManagedAgentActivityEventPayload,
  type ManagedAgentEventBridge,
} from '@/lib/managed-agent-runtime/event-bridge'
import { createManagedAgentSessionReconcilePort } from '@/lib/managed-agent-runtime/reconcile-port'

type ComposerAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  dataUrl?: string
  previewUrl?: string
  kind?: 'image' | 'file' | 'audio'
}

export type ManagedAgentComposerState = {
  /**
   * Engine-owned submit admission. `available` before the canonical session
   * exists (first message activates); `blocked` carries `blockedReason`.
   */
  availability: 'available' | 'blocked'
  blockedReason: string | null
  /** A submit is in flight (send command not yet settled). */
  isSubmitting: boolean
  /** Follow-ups held in the prompt queue while a turn runs. */
  queuedCount: number
  /**
   * Capability projection from the engine session snapshot. `null` means the
   * runtime has not reported capabilities — display "unknown", never invent.
   */
  capabilities: AgentActivitySession['capabilities']
}

export type ManagedAgentInteractionResponseInput = {
  turnId: string
  requestId: string
  action?: string
  optionId?: string
  payload?: Record<string, unknown>
}

export type ManagedAgentChat = {
  activeSessionId: string
  messages: Array<ChatMessage>
  isStreaming: boolean
  turnBusy: boolean
  /** Message id that should render live streaming chrome for the active turn. */
  streamingMessageId: string | null
  activeToolCalls: Array<{ id: string; name: string; phase: string; args?: unknown }>
  interactions: Array<AgentActivityInteraction>
  /**
   * Engine response-tracking state per interaction, keyed by
   * canonicalInteractionKey. Drives per-card submitting/failed settlement;
   * answered/superseded come from the canonical interaction itself.
   */
  interactionResponses: Record<
    string,
    Pick<InteractionResponseState, 'status' | 'errorMessage'> | undefined
  >
  error: string | null
  activeTitle: string
  fileChanges: unknown
  usage: unknown
  composer: ManagedAgentComposerState
  submit: (text: string, attachments: Array<ComposerAttachment>, options?: { effort?: string }) => Promise<void>
  abort: () => void
  clearMessages: () => void
  startNewSession: () => void
  respondToInteraction: (input: ManagedAgentInteractionResponseInput) => Promise<void>
}

interface ManagedAgentChatRuntime {
  displaySessionId: string
  workspaceId: string
  engine: AgentSessionEngine
  coordinator: ReturnType<typeof createAgentActivityWorkspaceEventCoordinator>
  projectCanonicalSnapshot: ReturnType<typeof createAgentActivitySnapshotProjector>
  bridge: ManagedAgentEventBridge
  executeSessionReconcile(
    command: SessionReconcileCommand,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
}

const EMPTY_CHAT_STATE = {
  messages: [] as Array<ChatMessage>,
  activeTurn: null as ReturnType<typeof selectManagedAgentChatState>['activeTurn'],
  latestTurn: null as ReturnType<typeof selectManagedAgentChatState>['latestTurn'],
  fileChanges: null as ReturnType<typeof selectManagedAgentChatState>['fileChanges'],
  usage: null as ReturnType<typeof selectManagedAgentChatState>['usage'],
  sessionTitle: null as string | null,
  isStreaming: false,
  turnBusy: false,
  streamingMessageId: null as string | null,
  error: null as string | null,
  interactions: [] as Array<AgentActivityInteraction>,
  activeToolCalls: [] as Array<{ id: string; name: string; phase: string; args?: unknown }>,
}

function createWindowScheduler(): EngineScheduler {
  return {
    schedule(delayMs, task) {
      const timer = window.setTimeout(task, delayMs)
      return { cancel: () => window.clearTimeout(timer) }
    },
  }
}

export function useManagedAgentChat({
  agentId,
  runtime,
  sessionId,
  onSessionResolved,
}: {
  agentId: string
  runtime: string
  sessionId: string | null
  onSessionResolved?: (payload: { sessionKey: string; friendlyId: string }) => void
}): ManagedAgentChat {
  const [stableNewSessionId] = useState(() => `new-${Date.now()}`)
  const activeSessionId = sessionId ?? stableNewSessionId
  const setActiveSessionId = useAgentStore((state) => state.setActiveSessionId)
  const setSessions = useAgentStore((state) => state.setSessions)
  const selectedModel = useSessionModelStore((state) => state.models[activeSessionId])
  const transferModel = useSessionModelStore((state) => state.transferModel)
  const getStoredModel = useSessionModelStore((state) => state.getModel)
  const [error, setError] = useState<string | null>(null)
  const [engine, setEngine] = useState<AgentSessionEngine | null>(null)
  const runtimeRef = useRef<ManagedAgentChatRuntime | null>(null)
  const runtimeCreationRef = useRef<{
    displaySessionId: string
    promise: Promise<ManagedAgentChatRuntime>
    dispose(): void
  } | null>(null)
  const engineDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canonicalSessionIdRef = useRef<string | null>(null)
  const displaySessionIdRef = useRef(activeSessionId)
  const preserveCanonicalForDisplaySessionRef = useRef<string | null>(null)
  const pendingDisplaySessionIdRef = useRef<string | null>(null)
  const activityGenerationRef = useRef(0)
  const sessionListGenerationRef = useRef(0)
  displaySessionIdRef.current = activeSessionId

  const reconcileCurrentSession = useCallback(() => {
    const runtime = runtimeRef.current
    const canonicalSessionId = canonicalSessionIdRef.current
    if (!runtime || !canonicalSessionId) return
    runtime.engine.dispatch({
      agentSessionId: canonicalSessionId,
      needsMessages: true,
      needsState: true,
      type: 'session/reconcileRequested',
      workspaceId: runtime.workspaceId,
    })
  }, [])

  const executeExtensionCommand = useCallback(
    async (command: EngineExtensionCommand, options?: EngineEffectOptions) => {
      if (command.type === 'session/reconcile') {
        const runtime = runtimeRef.current
        if (!runtime) throw new Error('Managed Agent runtime is not ready')
        return runtime.executeSessionReconcile(command, { signal: options?.signal })
      }
      if (command.type === 'engine/reconcileWorkspace') {
        reconcileCurrentSession()
        return
      }
      throw new Error(`Unsupported Managed Agent command: ${command.type}`)
    },
    [reconcileCurrentSession],
  )

  const refreshSessionList = useCallback(async () => {
    const generation = ++sessionListGenerationRef.current
    try {
      const data = await fetchSessionsForAgent(agentId)
      if (generation !== sessionListGenerationRef.current) return
      setSessions(agentId, data.sessions)
    } catch {
      /* sidebar retries via useExternalAgentSessions */
    }
  }, [agentId, setSessions])

  const commandPortRef = useRef<EngineTypedCommandPort | null>(null)
  if (!commandPortRef.current) {
    commandPortRef.current = createManagedAgentCommandPort(
      agentId,
      (detail) => {
        const runtime = runtimeRef.current
        if (!runtime) return
        canonicalSessionIdRef.current = detail.session.agentSessionId
        hydrateManagedAgentEngine(runtime.engine, detail)
        const pendingDisplaySessionId = pendingDisplaySessionIdRef.current
        if (pendingDisplaySessionId) {
          pendingDisplaySessionIdRef.current = null
          preserveCanonicalForDisplaySessionRef.current = pendingDisplaySessionId
          setActiveSessionId(pendingDisplaySessionId)
          writeLastSession(pendingDisplaySessionId, agentId)
        }
        void refreshSessionList()
      },
      {
        displaySessionId: () => displaySessionIdRef.current,
        executeExtensionCommand,
      },
    )
  }

  const reconcilePortRef = useRef(createManagedAgentSessionReconcilePort({
    agentId,
    resolveDisplaySessionId: (agentSessionId) =>
      agentSessionId === canonicalSessionIdRef.current
        ? displaySessionIdRef.current
        : agentSessionId,
  }))

  const ensureRuntime = useCallback((displaySessionId: string, generation: number): Promise<ManagedAgentChatRuntime> => {
    const existing = runtimeCreationRef.current
    if (existing) {
      if (existing.displaySessionId === displaySessionId) return existing.promise
      existing.dispose()
      runtimeCreationRef.current = null
    }
    let resolvePromise!: (runtime: ManagedAgentChatRuntime) => void
    const promise = new Promise<ManagedAgentChatRuntime>((resolve) => {
      resolvePromise = resolve
    })
    const bridge = createManagedAgentEventBridge({
      agentId,
      displaySessionId,
      onConnected: (workspaceId) => {
        if (runtimeRef.current) {
          // SSE (re)connect after the first one: events are hints only, so a
          // reconnect means frames may have been missed — reconnect + reconcile.
          runtimeRef.current.engine.dispatch({
            status: 'connected',
            type: 'engine/connectionChanged',
            workspaceId,
          })
          runtimeRef.current.coordinator.eventStreamConnectionChanged({
            prioritySessionIds: canonicalSessionIdRef.current
              ? [canonicalSessionIdRef.current]
              : [],
            status: 'connected',
          })
          reconcileCurrentSession()
          return
        }
        const scheduler = createWindowScheduler()
        const engine = createManagedAgentEngine({
          workspaceId,
          commandPort: commandPortRef.current!,
        })
        const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
        const coordinator = createAgentActivityWorkspaceEventCoordinator({
          engine,
          notificationScheduler: scheduler,
          readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
          workspaceId,
        })
        const executor = createAgentActivitySessionReconcileExecutor({
          childMessageHydration: 'requested_session',
          engine,
          isSessionDeleted: (agentSessionId) => coordinator.isSessionDeleted(agentSessionId),
          port: reconcilePortRef.current,
          reconcileAuthoritativeHistory: (agentSessionId, messages, turns) =>
            coordinator.reconcileAuthoritativeHistory(agentSessionId, messages, turns),
          reconcileOptimisticMessages: (agentSessionId) =>
            coordinator.reconcileMessages(agentSessionId),
          workspaceId,
        })
        const runtime: ManagedAgentChatRuntime = {
          bridge,
          coordinator,
          displaySessionId,
          engine,
          executeSessionReconcile: (command, options) => executor.execute(command, options),
          projectCanonicalSnapshot: projectSnapshot,
          workspaceId,
        }
        runtimeRef.current = runtime
        engine.dispatch({
          status: 'connected',
          type: 'engine/connectionChanged',
          workspaceId,
        })
        coordinator.eventStreamConnectionChanged({ status: 'connected' })
        if (generation === activityGenerationRef.current) setEngine(engine)
        resolvePromise(runtime)
      },
      onActivity: (payload: ManagedAgentActivityEventPayload) => {
        const runtime = runtimeRef.current
        if (!runtime || runtime.bridge !== bridge) return
        runtime.coordinator.ingestEvent(payload)
      },
      onMalformedActivity: () => reconcileCurrentSession(),
      onReconnectRequested: () => reconcileCurrentSession(),
      onTransportDisconnected: () => {
        const runtime = runtimeRef.current
        if (!runtime || runtime.bridge !== bridge) return
        runtime.engine.dispatch({
          status: 'disconnected',
          type: 'engine/connectionChanged',
          workspaceId: runtime.workspaceId,
        })
        runtime.coordinator.eventStreamConnectionChanged({ status: 'disconnected' })
      },
    })
    runtimeCreationRef.current = {
      displaySessionId,
      promise,
      dispose: () => bridge.dispose(),
    }
    return promise
  }, [agentId, reconcileCurrentSession])

  const fetchSessionDetail = useCallback(async (displaySessionId: string): Promise<AgentActivitySessionDetailSnapshot> => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(displaySessionId)}/detail`)
    if (!response.ok) {
      const error = new Error(`Managed Agent session detail failed: ${response.status}`) as Error & {
        status?: number
      }
      error.status = response.status
      throw error
    }
    const body = await response.json().catch(() => null) as { detail?: AgentActivitySessionDetailSnapshot } | null
    if (!body?.detail?.session?.agentSessionId) {
      throw new Error('Managed Agent session detail returned an invalid snapshot')
    }
    return body.detail
  }, [agentId])

  // Attaches to an existing display session: identity comes from the SSE
  // `connected` frame, the first detail snapshot hydrates session/turn state,
  // and one reconcile pass hydrates message history through the afterVersion
  // paginated messages route.
  const attachToSession = useCallback(async (displaySessionId: string, generation: number) => {
    const runtime = await ensureRuntime(displaySessionId, generation)
    if (generation !== activityGenerationRef.current) return
    if (canonicalSessionIdRef.current) return // already attached (e.g. activation)
    let detail: AgentActivitySessionDetailSnapshot
    try {
      detail = await fetchSessionDetail(displaySessionId)
    } catch (reason) {
      // Daemon 404 = pruned / unknown session. Clear selection and refresh the
      // daemon-owned sidebar list — do not auto-delete (click must not vanish).
      const status = reason && typeof reason === 'object' && 'status' in reason
        ? Number((reason as { status?: number }).status)
        : NaN
      if (status === 404) {
        void refreshSessionList()
        if (generation === activityGenerationRef.current) {
          setActiveSessionId(null)
        }
        return
      }
      throw reason
    }
    if (generation !== activityGenerationRef.current) return
    canonicalSessionIdRef.current = detail.session.agentSessionId
    hydrateManagedAgentSessionDetail(runtime.engine, detail)
    reconcileCurrentSession()
    void refreshSessionList()
  }, [
    ensureRuntime,
    fetchSessionDetail,
    reconcileCurrentSession,
    refreshSessionList,
    setActiveSessionId,
  ])

  useEffect(() => {
    const generation = activityGenerationRef.current + 1
    activityGenerationRef.current = generation
    setError(null)
    if (engineDisposeTimerRef.current) {
      clearTimeout(engineDisposeTimerRef.current)
      engineDisposeTimerRef.current = null
    }
    const previousRuntime = runtimeRef.current
    const preserveCanonical =
      preserveCanonicalForDisplaySessionRef.current === activeSessionId
    preserveCanonicalForDisplaySessionRef.current = null
    if (previousRuntime && previousRuntime.displaySessionId !== activeSessionId) {
      runtimeRef.current = null
      previousRuntime.bridge.dispose()
      previousRuntime.coordinator.dispose()
      previousRuntime.engine.dispose()
      // Drop any in-flight creation belonging to the disposed runtime, else
      // ensureRuntime() below resurrects its already-disposed bridge and the
      // new session hydrates into a dead engine (blank conversation view).
      if (
        runtimeCreationRef.current &&
        runtimeCreationRef.current.displaySessionId === previousRuntime.displaySessionId
      ) {
        runtimeCreationRef.current = null
      }
      if (!preserveCanonical) canonicalSessionIdRef.current = null
      setEngine(null)
    } else if (previousRuntime && !preserveCanonical && canonicalSessionIdRef.current) {
      previousRuntime.engine.dispatch({
        type: 'session/removed',
        agentSessionId: canonicalSessionIdRef.current,
      })
      canonicalSessionIdRef.current = null
    }
    const pendingCreation = runtimeCreationRef.current
    if (pendingCreation && pendingCreation.displaySessionId !== activeSessionId) {
      pendingCreation.dispose()
      runtimeCreationRef.current = null
    }
    if (activeSessionId.startsWith('new-')) return
    displaySessionIdRef.current = activeSessionId
    void attachToSession(activeSessionId, generation).catch((reason) => {
      if (generation === activityGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })
    onSessionResolved?.({ sessionKey: activeSessionId, friendlyId: activeSessionId })
  }, [activeSessionId, attachToSession, onSessionResolved])

  // Real unmount: defer disposal so a Strict Mode remount can adopt the live
  // runtime (same displaySessionId) without losing the SSE bridge.
  useEffect(() => {
    return () => {
      const runtime = runtimeRef.current
      const pendingCreation = runtimeCreationRef.current
      runtimeCreationRef.current = null
      if (pendingCreation) pendingCreation.dispose()
      if (!runtime) return
      engineDisposeTimerRef.current = setTimeout(() => {
        runtime.bridge.dispose()
        runtime.coordinator.dispose()
        runtime.engine.dispose()
      }, 0)
    }
  }, [])

  const engineSnapshot = useSyncExternalStore(
    useCallback(
      (listener) => (engine ? subscribeManagedAgentEngine(engine, listener) : () => undefined),
      [engine],
    ),
    () => engine?.getSnapshot() ?? null,
    () => engine?.getSnapshot() ?? null,
  )
  // Overlay-only message_delta updates notify the coordinator, not the engine.
  // Subscribe so streaming toolOutput / text patches re-render before reconcile.
  const overlayEpochRef = useRef(0)
  const overlayEpoch = useSyncExternalStore(
    useCallback(
      (listener) => {
        const coordinator = runtimeRef.current?.coordinator
        if (!engine || !coordinator) return () => undefined
        return coordinator.subscribe(() => {
          overlayEpochRef.current += 1
          listener()
        })
      },
      [engine],
    ),
    () => overlayEpochRef.current,
    () => 0,
  )
  // coordinator.project expects AgentActivitySnapshot (projector output), never
  // raw engine state. Engine selectors still own turns / interactions / composer.
  const chatState = useMemo(() => {
    if (!engineSnapshot) return EMPTY_CHAT_STATE
    const agentSessionId = canonicalSessionIdRef.current
    const runtime = runtimeRef.current
    const sessionMessages =
      runtime && agentSessionId
        ? runtime.coordinator.project(
            runtime.projectCanonicalSnapshot(engineSnapshot),
          ).sessionMessagesById[agentSessionId]
        : undefined
    return selectManagedAgentChatState(engineSnapshot, agentSessionId, {
      sessionMessages,
      isSubmitting: agentSessionId
        ? selectSessionIsSubmitting(engineSnapshot, agentSessionId)
        : false,
    })
  }, [engineSnapshot, overlayEpoch])

  // Keep engine interactions aligned with waiting_approval tool rows so
  // submitInteractionResponse can admit clicks (Tutti derives prompts from
  // those rows; Agorax also needs the Interaction entity for respond).
  useEffect(() => {
    const runtime = runtimeRef.current
    const agentSessionId = canonicalSessionIdRef.current
    if (!runtime || !agentSessionId || !engineSnapshot) return
    const sessionMessages =
      runtime.coordinator.project(
        runtime.projectCanonicalSnapshot(engineSnapshot),
      ).sessionMessagesById[agentSessionId] ?? []
    syncPendingApprovalsIntoEngine(runtime.engine, sessionMessages)
  }, [engineSnapshot, overlayEpoch])

  // Per-interaction response settlement, straight from the engine's
  // interactionResponsesById — the panel joins these with the canonical
  // interactions (canonical status wins for answered/superseded).
  const interactionResponses = useMemo(() => {
    const result: ManagedAgentChat['interactionResponses'] = {}
    const agentSessionId = canonicalSessionIdRef.current
    if (!engineSnapshot || !agentSessionId) return result
    for (const interaction of selectEngineInteractionsForSession(
      engineSnapshot,
      agentSessionId,
    )) {
      result[
        canonicalInteractionKey(
          agentSessionId,
          interaction.turnId,
          interaction.requestId,
        )
      ] = selectEngineInteractionResponse(
        engineSnapshot,
        agentSessionId,
        interaction.turnId,
        interaction.requestId,
      ) ?? undefined
    }
    return result
  }, [engineSnapshot])

  // Composer contract comes from engine selectors, not local heuristics:
  // submit admission (blocked while the runtime reports unavailable or a
  // pending interaction holds the session), in-flight submit, and the
  // composer-visible prompt queue depth (excludes immediate-send / in-flight).
  const composer: ManagedAgentComposerState = useMemo(() => {
    if (!engineSnapshot) {
      return {
        availability: 'available',
        blockedReason: null,
        isSubmitting: false,
        queuedCount: 0,
        capabilities: null,
      }
    }
    const agentSessionId = canonicalSessionIdRef.current
    const availability = selectEngineSubmitAvailability(engineSnapshot, agentSessionId)
    return {
      availability: availability?.state ?? 'available',
      blockedReason: availability?.reason ?? null,
      isSubmitting: agentSessionId ? selectSessionIsSubmitting(engineSnapshot, agentSessionId) : false,
      queuedCount: agentSessionId
        ? selectEngineVisibleQueuedPrompts(engineSnapshot, agentSessionId).length
        : 0,
      capabilities: agentSessionId
        ? selectEngineSession(engineSnapshot, agentSessionId)?.capabilities ?? null
        : null,
    }
  }, [engineSnapshot])

  const submit = useCallback(async (
    text: string,
    attachments: Array<ComposerAttachment>,
    options?: { effort?: string },
  ) => {
    if (!text.trim() && attachments.length === 0) return
    setError(null)
    try {
      const promptContent = managedPromptContentFromAttachments({ text, attachments })
      const generation = activityGenerationRef.current
      let chatRuntime = runtimeRef.current
      if (!canonicalSessionIdRef.current) {
        // End-state identity: one UUID for sidebar + daemon agentSessionId.
        const sessionId = activeSessionId.startsWith('new-')
          ? crypto.randomUUID()
          : activeSessionId
        if (activeSessionId.startsWith('new-')) {
          transferModel(activeSessionId, sessionId)
          if (!getStoredModel(sessionId)) {
            transferModel(pendingSessionModelKey(agentId), sessionId)
          }
          pendingDisplaySessionIdRef.current = sessionId
        }
        displaySessionIdRef.current = sessionId
        chatRuntime = await ensureRuntime(sessionId, generation)
        if (generation !== activityGenerationRef.current) {
          throw new Error('Managed Agent session changed before activation')
        }
        const clientSubmitId = crypto.randomUUID()
        // Homologous with Hermes: seed user + empty pending host before runtime.
        ingestManagedUserPromptMessage({
          engine: chatRuntime.engine,
          workspaceId: chatRuntime.workspaceId,
          agentSessionId: sessionId,
          clientSubmitId,
          text,
          agentTargetId: managedAgentTargetIdForRuntime(runtime, agentId),
        })
        const accepted = chatRuntime.engine.activateSession({
          mode: 'new',
          agentSessionId: sessionId,
          agentTargetId: managedAgentTargetIdForRuntime(runtime, agentId),
          clientSubmitId,
          requestId: crypto.randomUUID(),
          initialTurnExpected: true,
          initialContent: promptContent,
          initialDisplayPrompt: text,
          settings: {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(options?.effort ? { reasoningEffort: options.effort } : {}),
          },
        })
        if (!accepted) throw new Error('Managed Agent activation was not accepted')
      } else {
        if (!chatRuntime) chatRuntime = await ensureRuntime(displaySessionIdRef.current, generation)
        const agentSessionId = canonicalSessionIdRef.current
        // Existing sessions resume with a sticky provider model. Composer picks
        // only live in session-model-store unless we push them through
        // updateSessionSettings (ACP session/set_model) before the prompt.
        // The prompt queue drains only after the settings write settles.
        const settingsPatch = managedSessionSettingsPatch({
          selectedModel,
          effort: options?.effort,
          current: selectEngineSession(
            chatRuntime.engine.getSnapshot(),
            agentSessionId,
          )?.settings,
        })
        if (settingsPatch) {
          chatRuntime.engine.updateSessionSettings({
            agentSessionId,
            settings: settingsPatch,
          })
        }
        const clientSubmitId = crypto.randomUUID()
        ingestManagedUserPromptMessage({
          engine: chatRuntime.engine,
          workspaceId: chatRuntime.workspaceId,
          agentSessionId,
          clientSubmitId,
          text,
        })
        chatRuntime.engine.submitPrompt({
          agentSessionId,
          clientSubmitId,
          content: promptContent,
          displayPrompt: text,
          routing: 'auto',
        })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    }
  }, [activeSessionId, agentId, runtime, ensureRuntime, getStoredModel, selectedModel, transferModel])

  const abort = useCallback(() => {
    const agentSessionId = canonicalSessionIdRef.current
    if (agentSessionId) runtimeRef.current?.engine.stopSession({ agentSessionId })
  }, [])

  const respondToInteraction = useCallback(async (input: ManagedAgentInteractionResponseInput) => {
    const agentSessionId = canonicalSessionIdRef.current
    const runtime = runtimeRef.current
    if (!runtime || !agentSessionId) {
      throw new Error('Interaction response was not accepted')
    }
    // Plan implement writeback goes through Host plan-decision (Codex
    // implement_prompt), not the generic interaction response path.
    if (input.action === 'implement') {
      const turnId = input.turnId.trim()
      const workspaceId = runtime.engine.identity.workspaceId
      const scopeKey = [
        'plan-implementation',
        workspaceId,
        agentSessionId,
        turnId,
      ].join(':')
      runtime.engine.dispatch({
        type: 'plan/decisionRequested',
        action: 'implement',
        agentSessionId,
        commandId: `plan-decision:${scopeKey}`,
        idempotencyKey: scopeKey,
        promptKind: 'plan-implementation',
        requestId: turnId,
        turnId,
        workspaceId,
        timeoutMs: 30_000,
      })
      return
    }
    // Ensure a pending Interaction exists before admit — synthesized cards from
    // waiting_approval tool rows are not always in the engine yet.
    const snapshot = runtime.engine.getSnapshot()
    const sessionMessages =
      runtime.coordinator.project(
        runtime.projectCanonicalSnapshot(snapshot),
      ).sessionMessagesById[agentSessionId] ?? []
    syncPendingApprovalsIntoEngine(runtime.engine, sessionMessages)
    if (!runtime.engine.submitInteractionResponse({ agentSessionId, ...input })) {
      throw new Error('Interaction response was not accepted')
    }
  }, [])

  const clearMessages = useCallback(() => {
    if (!activeSessionId.startsWith('new-')) void clearManagedSessionMessages(agentId, activeSessionId)
    const canonicalSessionId = canonicalSessionIdRef.current
    if (canonicalSessionId) {
      runtimeRef.current?.engine.dispatch({ type: 'session/removed', agentSessionId: canonicalSessionId })
    }
    canonicalSessionIdRef.current = null
  }, [activeSessionId, agentId])

  const startNewSession = useCallback(() => {
    pendingDisplaySessionIdRef.current = null
    preserveCanonicalForDisplaySessionRef.current = null
    setError(null)
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const activeTitle = useMemo(() => {
    if (chatState.sessionTitle) return chatState.sessionTitle.slice(0, 80)
    const firstUser = chatState.messages.find((message) => message.role === 'user')
    const text = firstUser?.content?.find((part) => part.type === 'text')
    return text?.type === 'text' && text.text ? text.text.slice(0, 40) : 'Chat'
  }, [chatState.messages, chatState.sessionTitle])

  return {
    activeSessionId,
    messages: chatState.messages,
    isStreaming: chatState.isStreaming,
    // Projected — isSubmitting only fills the pre-turn empty gap and cannot
    // override trailing assistant host content (sticky uncertain submits).
    turnBusy: chatState.turnBusy,
    streamingMessageId: chatState.streamingMessageId,
    activeToolCalls: chatState.activeToolCalls,
    interactions: [...chatState.interactions],
    interactionResponses,
    fileChanges: chatState.fileChanges,
    usage: chatState.usage,
    error: error ?? chatState.error,
    activeTitle,
    composer,
    submit,
    abort,
    clearMessages,
    startNewSession,
    respondToInteraction,
  }
}
