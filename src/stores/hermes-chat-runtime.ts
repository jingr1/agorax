/**
 * Hermes 1:1 chat runtime — Engine + coordinator + Tutti session reconcile.
 *
 * One runtime per workspaceId (profile). Browser maps via /api/agorax-run-mapping;
 * memory Map is a hot cache, collab.db is durable truth.
 *
 * Display SoT after settle: `createAgentActivitySessionReconcileExecutor` with
 * `authoritativeMessages` + `requiredHistoryRevision` fence (same as managed /
 * Tutti). RQ `/api/history` must not replace daemon-canonical Engine pages.
 */

import {
  createAgentActivitySessionReconcileExecutor,
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineSession,
  selectSessionIsSubmitting,
  selectSessionMessages,
  type AgentActivityUpdatedEvent,
  type AgentSessionEngine,
  type EngineEffectOptions,
  type EngineExtensionCommand,
  type SessionReconcileCommand,
} from '@agorax/agent-activity-core'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  ingestHermesUserPromptMessage,
  mergeHermesHistoryWhileBusy,
  reconcileHermesHistoryIntoEngine,
  selectHermesChatState,
} from '@/screens/chat/lib/hermes-agent-engine'
import { getRememberedOpenTurn } from '@/screens/chat/lib/engine-user-prompt-ingest'
import { createHermesSessionReconcilePort } from '@/lib/hermes-runtime/reconcile-port'
import { isDaemonCanonicalHistory } from '@/lib/hermes-display-sot'
import type { AgoraxRunMapping } from '@/server/agent-runtime/hermes-native-bridge'
import type { HermesSseEventName } from '@/lib/hermes-activity-adapter'
import type { ChatMessage } from '@/screens/chat/types'

export type HermesPendingSendOptions = {
  friendlyId?: string
  history?: Array<{ role: string; content: string }>
  thinking?: string
  fastMode?: boolean
  attachments?: unknown[]
  model?: string
}

export type HermesChatRuntime = {
  workspaceId: string
  engine: AgentSessionEngine
  coordinator: ReturnType<typeof createAgentActivityWorkspaceEventCoordinator>
  projectSnapshot: ReturnType<typeof createAgentActivitySnapshotProjector>
  getMapping: (agentSessionId: string) => Promise<AgoraxRunMapping | null>
  putMapping: (mapping: AgoraxRunMapping) => Promise<AgoraxRunMapping>
  ensureSessionHydrated: (agentSessionId: string) => void
  /**
   * External/CLI weak-id RQ pages only. Daemon-canonical pages must not replace
   * via RQ — Tutti authoritative path is `requestSessionReconcile`.
   */
  reconcileHistory: (
    agentSessionId: string,
    historyMessages: readonly ChatMessage[],
    historyRevision?: number,
  ) => number
  /** Tutti: dispatch session/reconcileRequested (executor + fence). */
  requestSessionReconcile: (
    agentSessionId: string,
    input?: {
      authoritativeMessages?: boolean
      requiredHistoryRevision?: number
      needsMessages?: boolean
      needsState?: boolean
    },
  ) => void
  executeSessionReconcile: (
    command: SessionReconcileCommand,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>
  ingestUserPrompt: (input: {
    agentSessionId: string
    clientSubmitId: string
    text: string
  }) => boolean
  setPendingSendOptions: (
    clientSubmitId: string,
    options: HermesPendingSendOptions,
  ) => void
  takePendingSendOptions: (
    clientSubmitId: string,
  ) => HermesPendingSendOptions | null
  dispose: () => void
}

type RuntimeHooks = {
  profileName?: string | null
  onSseFrame?: (input: {
    agentSessionId: string
    event: HermesSseEventName
    data: Record<string, unknown>
  }) => void
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
  takePendingSendOptions?: (
    clientSubmitId: string,
  ) => HermesPendingSendOptions | null
}

const runtimes = new Map<string, HermesChatRuntime>()
const mappingCache = new Map<string, AgoraxRunMapping>()
const pendingSendBySubmitId = new Map<string, HermesPendingSendOptions>()
const pendingSendWaiters = new Map<
  string,
  {
    resolve: () => void
    reject: (error: unknown) => void
  }
>()

function mergeRuntimeHooks(
  current: RuntimeHooks | undefined,
  next: RuntimeHooks | undefined,
): RuntimeHooks | undefined {
  if (!next) return current
  if (!current) return next
  // Partial updates must not wipe stream display hooks. useHermesEngineChatState
  // re-enters getHermesChatRuntime every render with only profileName — clearing
  // onSseFrame caused empty fullText + false "Connection lost" after a successful send.
  return {
    ...current,
    ...next,
    onSseFrame: next.onSseFrame ?? current.onSseFrame,
    onSessionResolved: next.onSessionResolved ?? current.onSessionResolved,
    takePendingSendOptions:
      next.takePendingSendOptions ?? current.takePendingSendOptions,
    profileName:
      next.profileName !== undefined ? next.profileName : current.profileName,
  }
}

export function notifyHermesSendCompleted(
  clientSubmitId: string,
  error?: unknown,
): void {
  const id = clientSubmitId.trim()
  if (!id) return
  const waiter = pendingSendWaiters.get(id)
  if (!waiter) return
  pendingSendWaiters.delete(id)
  if (error !== undefined) waiter.reject(error)
  else waiter.resolve()
}

export function waitForHermesSendCompleted(
  clientSubmitId: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const id = clientSubmitId.trim()
  if (!id) return Promise.resolve()
  const timeoutMs = options?.timeoutMs ?? 600_000
  return new Promise((resolve, reject) => {
    const prev = pendingSendWaiters.get(id)
    if (prev) {
      prev.reject(new Error('Hermes send waiter superseded'))
      pendingSendWaiters.delete(id)
    }
    const timer = window.setTimeout(() => {
      pendingSendWaiters.delete(id)
      options?.signal?.removeEventListener('abort', onAbort)
      reject(new Error('Hermes send completion timed out'))
    }, timeoutMs)
    const onAbort = () => {
      window.clearTimeout(timer)
      pendingSendWaiters.delete(id)
      reject(options?.signal?.reason ?? new Error('aborted'))
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    pendingSendWaiters.set(id, {
      resolve: () => {
        window.clearTimeout(timer)
        options?.signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      reject: (error) => {
        window.clearTimeout(timer)
        options?.signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    })
  })
}

function rememberMapping(mapping: AgoraxRunMapping): AgoraxRunMapping {
  mappingCache.set(mapping.agentSessionId, mapping)
  return mapping
}

async function fetchMapping(
  agentSessionId: string,
): Promise<AgoraxRunMapping | null> {
  const id = agentSessionId.trim()
  if (!id) return null
  const cached = mappingCache.get(id)
  if (cached) return cached
  try {
    const res = await fetch(
      `/api/agorax-run-mapping?agentSessionId=${encodeURIComponent(id)}`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { mapping?: AgoraxRunMapping | null }
    if (body.mapping?.agentSessionId) return rememberMapping(body.mapping)
  } catch {
    // ignore
  }
  return null
}

async function persistMapping(
  mapping: AgoraxRunMapping,
): Promise<AgoraxRunMapping> {
  const retained = rememberMapping(mapping)
  try {
    const res = await fetch('/api/agorax-run-mapping', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mapping),
    })
    if (res.ok) {
      const body = (await res.json()) as { mapping?: AgoraxRunMapping }
      if (body.mapping?.agentSessionId) {
        return rememberMapping(body.mapping)
      }
    }
  } catch {
    // keep memory cache even if DB write fails
  }
  return retained
}

export function getHermesChatRuntime(
  workspaceId: string,
  hooks?: RuntimeHooks,
): HermesChatRuntime {
  const id = workspaceId.trim() || 'default'
  const existing = runtimes.get(id)
  if (existing) {
    const withHooks = existing as HermesChatRuntime & {
      _hooks?: RuntimeHooks
    }
    withHooks._hooks = mergeRuntimeHooks(withHooks._hooks, hooks)
    return existing
  }

  const hooksRef: { current: RuntimeHooks | undefined } = { current: hooks }

  let engine!: AgentSessionEngine
  let executeSessionReconcile!: (
    command: SessionReconcileCommand,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>

  const requestSessionReconcile = (
    agentSessionId: string,
    input?: {
      authoritativeMessages?: boolean
      requiredHistoryRevision?: number
      needsMessages?: boolean
      needsState?: boolean
    },
  ) => {
    const sid = agentSessionId.trim()
    if (!sid) return
    engine.dispatch({
      type: 'session/reconcileRequested',
      agentSessionId: sid,
      workspaceId: id,
      needsMessages: input?.needsMessages ?? true,
      needsState: input?.needsState ?? true,
      ...(input?.authoritativeMessages
        ? { authoritativeMessages: true }
        : {}),
      ...(typeof input?.requiredHistoryRevision === 'number' &&
      input.requiredHistoryRevision > 0
        ? { requiredHistoryRevision: input.requiredHistoryRevision }
        : {}),
    })
  }

  const executeExtensionCommand = async (
    command: EngineExtensionCommand,
    effectOptions?: EngineEffectOptions,
  ) => {
    if (command.type === 'session/reconcile') {
      return executeSessionReconcile(command, {
        signal: effectOptions?.signal,
      })
    }
    if (command.type === 'engine/reconcileWorkspace') {
      const snap = engine.getSnapshot()
      for (const sid of Object.keys(
        snap.sessionLifecycle.sessionsById ?? {},
      )) {
        requestSessionReconcile(sid, {
          needsMessages: true,
          needsState: true,
        })
      }
      return
    }
    throw new Error(`Unsupported Hermes command: ${command.type}`)
  }

  const commandPort = createHermesCommandPort({
    workspaceId: id,
    profileName: hooks?.profileName,
    getMapping: fetchMapping,
    putMapping: persistMapping,
    takePendingSendOptions: (clientSubmitId) => {
      const fromHook = hooksRef.current?.takePendingSendOptions?.(clientSubmitId)
      if (fromHook) return fromHook
      const cached = pendingSendBySubmitId.get(clientSubmitId) ?? null
      if (cached) pendingSendBySubmitId.delete(clientSubmitId)
      return cached
    },
    onActivityEvent: (event: AgentActivityUpdatedEvent) => {
      const runtime = runtimes.get(id)
      if (!runtime) return
      runtime.coordinator.ingestEvent(event)
    },
    onSseFrame: (frame) => {
      hooksRef.current?.onSseFrame?.(frame)
    },
    onSessionResolved: (payload) => {
      hooksRef.current?.onSessionResolved?.(payload)
    },
    onSendCompleted: (clientSubmitId, error) => {
      notifyHermesSendCompleted(clientSubmitId, error)
    },
    shouldPromoteResolvedSession: ({ requestedSessionKey }) =>
      requestedSessionKey === 'new' || requestedSessionKey === 'main',
    executeExtensionCommand,
    onSettledAuthoritativeReconcile: ({ agentSessionId, historyRevision }) => {
      requestSessionReconcile(agentSessionId, {
        authoritativeMessages: true,
        requiredHistoryRevision: historyRevision,
        needsMessages: false,
        needsState: false,
      })
    },
  })

  engine = createHermesAgentEngine({ workspaceId: id, commandPort })
  const projectSnapshot = createAgentActivitySnapshotProjector(id)
  const coordinator = createAgentActivityWorkspaceEventCoordinator({
    engine,
    notificationScheduler: {
      schedule(delayMs, task) {
        const timer = window.setTimeout(task, delayMs)
        return { cancel: () => clearTimeout(timer) }
      },
    },
    readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
    workspaceId: id,
  })

  const reconcilePort = createHermesSessionReconcilePort({
    // Hermes runtime workspaceId is the profile name (default / named).
    profileName: id,
  })
  const executor = createAgentActivitySessionReconcileExecutor({
    childMessageHydration: 'requested_session',
    engine,
    isSessionDeleted: (agentSessionId) =>
      coordinator.isSessionDeleted(agentSessionId),
    port: reconcilePort,
    reconcileAuthoritativeHistory: (agentSessionId, messages, turns) =>
      coordinator.reconcileAuthoritativeHistory(
        agentSessionId,
        messages,
        turns,
      ),
    reconcileOptimisticMessages: (agentSessionId) =>
      coordinator.reconcileMessages(agentSessionId),
    workspaceId: id,
  })
  executeSessionReconcile = (command, options) =>
    executor.execute(command, options)

  engine.dispatch({
    status: 'connected',
    type: 'engine/connectionChanged',
    workspaceId: id,
  })
  coordinator.eventStreamConnectionChanged({ status: 'connected' })

  const runtime: HermesChatRuntime & { _hooks?: RuntimeHooks } = {
    workspaceId: id,
    engine,
    coordinator,
    projectSnapshot,
    getMapping: fetchMapping,
    putMapping: persistMapping,
    ensureSessionHydrated(agentSessionId: string) {
      const sid = agentSessionId.trim()
      if (!sid) return
      if (selectEngineSession(engine.getSnapshot(), sid)) return
      const knownGateway =
        mappingCache.get(sid)?.gatewaySessionId?.trim() || null
      hydrateHermesAgentEngine(
        engine,
        createHermesSessionSkeleton({
          workspaceId: id,
          agentSessionId: sid,
          providerSessionId: knownGateway ?? sid,
        }),
      )
    },
    reconcileHistory(agentSessionId, historyMessages, _historyRevision) {
      const sid = agentSessionId.trim()
      if (!sid) return 0
      const snap = engine.getSnapshot()
      const submitting = selectSessionIsSubmitting(snap, sid)
      const busy = selectHermesChatState(snap, sid).turnBusy
      const openTurnRemembered = getRememberedOpenTurn(sid) !== null
      if (submitting || busy || openTurnRemembered) {
        return mergeHermesHistoryWhileBusy({
          engine,
          workspaceId: id,
          agentSessionId: sid,
          historyMessages,
        })
      }
      const projected =
        coordinator.project(projectSnapshot(snap)).sessionMessagesById[sid] ??
        selectSessionMessages(snap, sid)
      // Daemon SoT: prefer Tutti authoritative reconcile over RQ replace when
      // Engine already has rows. Cold-empty is different — deep links often
      // arrive under the wrong profile workspace; empty reconcile can race
      // the profile correction and leave a permanent blank list. Seed once
      // from daemon history so refresh shows content immediately.
      if (isDaemonCanonicalHistory(historyMessages)) {
        if ((projected?.length ?? 0) > 0) {
          return 0
        }
      }
      return reconcileHermesHistoryIntoEngine({
        engine,
        coordinator,
        workspaceId: id,
        agentSessionId: sid,
        historyMessages,
        projectedMessages: projected,
      })
    },
    requestSessionReconcile,
    executeSessionReconcile: (command, options) =>
      executeSessionReconcile(command, options),
    ingestUserPrompt(input) {
      return ingestHermesUserPromptMessage({
        engine,
        coordinator,
        workspaceId: id,
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        text: input.text,
      })
    },
    setPendingSendOptions(clientSubmitId, options) {
      const idKey = clientSubmitId.trim()
      if (!idKey) return
      pendingSendBySubmitId.set(idKey, options)
    },
    takePendingSendOptions(clientSubmitId) {
      const idKey = clientSubmitId.trim()
      const cached = pendingSendBySubmitId.get(idKey) ?? null
      if (cached) pendingSendBySubmitId.delete(idKey)
      return cached
    },
    dispose() {
      coordinator.dispose()
      runtimes.delete(id)
    },
  }

  Object.defineProperty(runtime, '_hooks', {
    get: () => hooksRef.current,
    set: (value: RuntimeHooks | undefined) => {
      hooksRef.current = mergeRuntimeHooks(hooksRef.current, value)
    },
    enumerable: false,
  })

  runtimes.set(id, runtime)
  return runtime
}

export function resetHermesChatRuntimesForTests(): void {
  for (const runtime of runtimes.values()) {
    runtime.dispose()
  }
  runtimes.clear()
  mappingCache.clear()
}

/** Drop a cached mapping so the next getMapping hits network/DB (or misses). */
export function forgetHermesMappingCache(agentSessionId: string): void {
  const id = agentSessionId.trim()
  if (id) mappingCache.delete(id)
}

/**
 * Hot-path read for createSession: activateSession writes the cache before the
 * DB round-trip. Polling GET would waste requests and can race a stale response.
 */
export function peekHermesMappingCache(
  agentSessionId: string,
): AgoraxRunMapping | null {
  const id = agentSessionId.trim()
  return id ? (mappingCache.get(id) ?? null) : null
}

/**
 * Wait until Engine has observed a busy turn and then returned to idle.
 * Used by the streaming hook after submitPrompt so callers can await completion.
 * Must not resolve on a *previous* settled latestTurn before the new turn starts.
 */
export function waitForHermesTurnSettle(
  runtime: HermesChatRuntime,
  agentSessionId: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 600_000
  const sid = agentSessionId.trim()
  const baselineTurnId =
    selectHermesChatState(runtime.engine.getSnapshot(), sid).latestTurn
      ?.turnId ?? null
  return new Promise((resolve, reject) => {
    let sawBusy = false
    const check = (): boolean => {
      const snap = runtime.engine.getSnapshot()
      const submitting = selectSessionIsSubmitting(snap, sid)
      const state = selectHermesChatState(snap, sid, {
        isSubmitting: submitting,
      })
      if (submitting || state.turnBusy || state.isStreaming) {
        sawBusy = true
        return false
      }
      if (!sawBusy) return false
      const latestId = state.latestTurn?.turnId ?? null
      if (
        state.latestTurn?.phase === 'settled' &&
        latestId &&
        latestId !== baselineTurnId
      ) {
        return true
      }
      return !state.turnBusy && !state.isStreaming
    }
    const finish = () => {
      window.clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      unsub()
      resolve()
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      unsub()
      reject(options?.signal?.reason ?? new Error('aborted'))
    }
    const unsub = runtime.engine.subscribe(() => {
      if (check()) finish()
    })
    const timer = window.setTimeout(() => {
      options?.signal?.removeEventListener('abort', onAbort)
      unsub()
      reject(new Error('Hermes turn settle timed out'))
    }, timeoutMs)
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    if (check()) finish()
  })
}

export { selectHermesChatState, mappingCache as hermesMappingCacheForTests }
