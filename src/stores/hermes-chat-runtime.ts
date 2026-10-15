/**
 * Hermes 1:1 chat runtime — Engine + coordinator + mapping cache.
 *
 * One runtime per workspaceId (profile). Browser maps via /api/agorax-run-mapping;
 * memory Map is a hot cache, collab.db is durable truth.
 */

import {
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineSession,
  selectSessionIsSubmitting,
  type AgentActivityUpdatedEvent,
  type AgentSessionEngine,
} from '@agorax/agent-activity-core'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  ingestHermesUserPromptMessage,
  reconcileHermesHistoryIntoEngine,
  selectHermesChatState,
} from '@/screens/chat/lib/hermes-agent-engine'
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
  /** Idle-path history → Engine (skip while turnBusy / submitting). */
  reconcileHistory: (
    agentSessionId: string,
    historyMessages: readonly ChatMessage[],
    historyRevision?: number,
  ) => number
  ingestUserPrompt: (input: {
    agentSessionId: string
    clientSubmitId: string
    text: string
  }) => void
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
    const existing = pendingSendWaiters.get(id)
    if (existing) {
      // Replace — newest waiter owns completion.
      pendingSendWaiters.delete(id)
    }
    const finish = (fn: () => void) => {
      window.clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      pendingSendWaiters.delete(id)
      fn()
    }
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error('Hermes send completion timed out')))
    }, timeoutMs)
    const onAbort = () => {
      finish(() =>
        reject(new DOMException('Aborted', 'AbortError')),
      )
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    pendingSendWaiters.set(id, {
      resolve: () => finish(() => resolve()),
      reject: (error) => finish(() => reject(error)),
    })
  })
}

async function fetchMapping(
  agentSessionId: string,
): Promise<AgoraxRunMapping | null> {
  const cached = mappingCache.get(agentSessionId)
  if (cached) return cached
  try {
    const res = await fetch(
      `/api/agorax-run-mapping?agentSessionId=${encodeURIComponent(agentSessionId)}`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { mapping?: AgoraxRunMapping | null }
    if (body.mapping?.agentSessionId) {
      mappingCache.set(body.mapping.agentSessionId, body.mapping)
      return body.mapping
    }
  } catch {
    // offline / route not generated yet
  }
  return null
}

async function persistMapping(
  mapping: AgoraxRunMapping,
): Promise<AgoraxRunMapping> {
  mappingCache.set(mapping.agentSessionId, mapping)
  try {
    const res = await fetch('/api/agorax-run-mapping', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mapping),
    })
    if (res.ok) {
      const body = (await res.json()) as { mapping?: AgoraxRunMapping }
      if (body.mapping?.agentSessionId) {
        mappingCache.set(body.mapping.agentSessionId, body.mapping)
        return body.mapping
      }
    }
  } catch {
    // keep memory cache even if DB write fails
  }
  return mapping
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
  })

  const engine = createHermesAgentEngine({ workspaceId: id, commandPort })
  const projectSnapshot = createAgentActivitySnapshotProjector(id)
  const coordinator = createAgentActivityWorkspaceEventCoordinator({
    engine,
    notificationScheduler: {
      schedule(delayMs, task) {
        const timer = window.setTimeout(task, delayMs)
        return { cancel: () => window.clearTimeout(timer) }
      },
    },
    readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
    workspaceId: id,
  })

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
      hydrateHermesAgentEngine(
        engine,
        createHermesSessionSkeleton({
          workspaceId: id,
          agentSessionId: sid,
          providerSessionId: mappingCache.get(sid)?.gatewaySessionId ?? sid,
        }),
      )
      void persistMapping({
        agentSessionId: sid,
        turnId: mappingCache.get(sid)?.turnId ?? null,
        gatewaySessionId: mappingCache.get(sid)?.gatewaySessionId ?? sid,
        assignmentId: null,
        hermesRunId: mappingCache.get(sid)?.hermesRunId ?? null,
        bridgeKind: 'hermes-native',
        updatedAtUnixMs: Date.now(),
      })
    },
    reconcileHistory(agentSessionId, historyMessages, historyRevision) {
      const sid = agentSessionId.trim()
      if (!sid) return 0
      const snap = engine.getSnapshot()
      if (selectSessionIsSubmitting(snap, sid)) return 0
      const busy = selectHermesChatState(snap, sid).turnBusy
      if (busy) return 0
      const projected =
        coordinator.project(projectSnapshot(snap)).sessionMessagesById[sid] ??
        []
      return reconcileHermesHistoryIntoEngine({
        engine,
        coordinator,
        workspaceId: id,
        agentSessionId: sid,
        historyMessages,
        historyRevision,
        projectedMessages: projected,
      })
    },
    ingestUserPrompt(input) {
      ingestHermesUserPromptMessage({
        engine,
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

  // Keep hooks ref in sync when callers re-enter getHermesChatRuntime.
  // Setter merges so partial updates cannot drop onSseFrame.
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
      // Idle after busy — optionally require a different/newer settled turn.
      const latestId = state.latestTurn?.turnId ?? null
      if (
        state.latestTurn?.phase === 'settled' &&
        latestId &&
        latestId !== baselineTurnId
      ) {
        return true
      }
      // Busy cleared even if turn id unchanged (cancel / interrupted).
      return !state.turnBusy && !state.isStreaming
    }
    const finish = () => {
      window.clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
      unsub()
      resolve()
    }
    const timer = window.setTimeout(() => {
      unsub()
      reject(new Error('Hermes turn settle timed out'))
    }, timeoutMs)
    const onAbort = () => {
      window.clearTimeout(timer)
      unsub()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    const unsub = runtime.engine.subscribe(() => {
      if (check()) finish()
    })
    if (check()) finish()
  })
}

export { selectHermesChatState, mappingCache as hermesMappingCacheForTests }
