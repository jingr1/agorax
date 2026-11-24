/**
 * Phase D: dual-subscribe Engine + coordinator overlay for Hermes 1:1.
 * List + turnBusy come only from selectHermesChatState (managed homology).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import {
  canonicalInteractionKey,
  selectEngineInteractionResponse,
  selectEngineInteractionsForSession,
  selectSessionIsSubmitting,
  selectSessionMessages,
  type InteractionResponseState,
} from '@agorax/agent-activity-core'
import {
  getHermesChatRuntime,
  selectHermesChatState,
} from '@/stores/hermes-chat-runtime'
import {
  clearRememberedOpenTurn,
  getRememberedOpenTurn,
} from '../lib/engine-user-prompt-ingest'
import type { AgentInteractionResponseInput } from '../components/agent-interaction-panel'
import type { ChatMessage } from '../types'

/**
 * Whether to fire Tutti `session/reconcileRequested` for a still-empty session.
 * Must be once-per-empty-session: the dispatch itself updates Engine snapshot
 * and would otherwise re-enter the cold-hydrate effect forever.
 *
 * Gate key includes workspaceId: deep-link profile correction remounts the
 * Hermes runtime under `architect` (etc.) while the session id stays the same
 * — without the workspace in the key, the first empty request under `default`
 * permanently suppresses hydrate on the owning workspace.
 */
export function emptySessionReconcileGateKey(
  workspaceId: string,
  agentSessionId: string,
): string {
  return `${workspaceId.trim() || 'default'}\0${agentSessionId.trim()}`
}

export function shouldRequestEmptySessionReconcile(input: {
  workspaceId?: string | null
  agentSessionId: string | null
  liveMessageCount: number
  alreadyRequestedFor: string | null
}): { request: boolean; nextAlreadyRequestedFor: string | null } {
  const sid = input.agentSessionId?.trim() || ''
  if (!sid) {
    return { request: false, nextAlreadyRequestedFor: null }
  }
  if (input.liveMessageCount > 0) {
    return { request: false, nextAlreadyRequestedFor: null }
  }
  const gateKey = emptySessionReconcileGateKey(
    input.workspaceId ?? 'default',
    sid,
  )
  if (input.alreadyRequestedFor === gateKey) {
    return { request: false, nextAlreadyRequestedFor: gateKey }
  }
  return { request: true, nextAlreadyRequestedFor: gateKey }
}

export function useHermesEngineChatState(input: {
  workspaceId: string
  agentSessionId: string | null
  profileName?: string | null
  /** UI optimistic sending — OR'd with Engine selectSessionIsSubmitting. */
  isSubmitting?: boolean
  /**
   * Gateway/RQ history. Daemon-canonical pages do not replace Engine (Tutti
   * authoritative reconcile owns that). External msg-* may still identity-merge.
   */
  historyMessages?: readonly ChatMessage[]
  historyReady?: boolean
}) {
  const workspaceId = input.workspaceId.trim() || 'default'
  const runtime = getHermesChatRuntime(workspaceId, {
    profileName: input.profileName,
  })

  const engineSnapshot = useSyncExternalStore(
    (listener) => runtime.engine.subscribe(listener),
    () => runtime.engine.getSnapshot(),
    () => runtime.engine.getSnapshot(),
  )

  const overlayEpochRef = useRef(0)
  const overlayEpoch = useSyncExternalStore(
    (listener) =>
      runtime.coordinator.subscribe(() => {
        overlayEpochRef.current += 1
        listener()
      }),
    () => overlayEpochRef.current,
    () => overlayEpochRef.current,
  )

  const agentSessionId = input.agentSessionId?.trim() || null
  const agentSessionIdRef = useRef(agentSessionId)
  agentSessionIdRef.current = agentSessionId

  const chatState = useMemo(() => {
    void overlayEpoch
    const sessionMessages = agentSessionId
      ? runtime.coordinator.project(runtime.projectSnapshot(engineSnapshot))
          .sessionMessagesById[agentSessionId]
      : undefined
    const engineSubmitting = agentSessionId
      ? selectSessionIsSubmitting(engineSnapshot, agentSessionId)
      : false
    return selectHermesChatState(engineSnapshot, agentSessionId, {
      sessionMessages,
      isSubmitting: input.isSubmitting === true || engineSubmitting,
    })
  }, [
    engineSnapshot,
    overlayEpoch,
    runtime,
    agentSessionId,
    input.isSubmitting,
  ])

  const interactionResponses = useMemo(() => {
    const result: Record<
      string,
      Pick<InteractionResponseState, 'status' | 'errorMessage'> | undefined
    > = {}
    if (!agentSessionId) return result
    for (const interaction of selectEngineInteractionsForSession(
      engineSnapshot,
      agentSessionId,
    )) {
      const response = selectEngineInteractionResponse(
        engineSnapshot,
        agentSessionId,
        interaction.turnId,
        interaction.requestId,
      )
      result[
        canonicalInteractionKey(
          agentSessionId,
          interaction.turnId,
          interaction.requestId,
        )
      ] = response
        ? {
            status: response.status,
            errorMessage: response.errorMessage,
          }
        : undefined
    }
    return result
  }, [engineSnapshot, agentSessionId])

  const respondToInteraction = useCallback(
    async (input: AgentInteractionResponseInput) => {
      const sid = agentSessionIdRef.current
      if (!sid) {
        throw new Error('Interaction response was not accepted')
      }
      if (
        !runtime.engine.submitInteractionResponse({
          agentSessionId: sid,
          ...input,
        })
      ) {
        throw new Error('Interaction response was not accepted')
      }
    },
    [runtime],
  )

  // Cold / reconnect: Tutti session reconcile (executor), not RQ whole-page
  // replace on turnBusy=false.
  //
  // Gate: request once per empty session. `requestSessionReconcile` always
  // dispatches → new engineSnapshot → this effect would otherwise loop and
  // trip React "Maximum update depth exceeded" (empty mapped Hermes history).
  const emptyReconcileRequestedForRef = useRef<string | null>(null)
  useEffect(() => {
    const sid = agentSessionId
    if (!sid || input.historyReady === false) {
      if (!sid) emptyReconcileRequestedForRef.current = null
      return
    }
    runtime.ensureSessionHydrated(sid)
    const live = selectSessionMessages(engineSnapshot, sid)
    const gate = shouldRequestEmptySessionReconcile({
      workspaceId,
      agentSessionId: sid,
      liveMessageCount: live.length,
      alreadyRequestedFor: emptyReconcileRequestedForRef.current,
    })
    emptyReconcileRequestedForRef.current = gate.nextAlreadyRequestedFor
    if (!gate.request) return
    runtime.requestSessionReconcile(sid, {
      needsMessages: true,
      needsState: true,
    })
  }, [agentSessionId, engineSnapshot, input.historyReady, runtime, workspaceId])

  // External weak-id RQ only — daemon-canonical history no-ops inside runtime.
  useEffect(() => {
    const sid = agentSessionId
    if (!sid || input.historyReady === false) return
    if (!input.historyMessages) return
    runtime.ensureSessionHydrated(sid)
    runtime.reconcileHistory(sid, input.historyMessages)
  }, [agentSessionId, input.historyMessages, input.historyReady, runtime])

  // Drop open-turn nonce only when *this* remembered turn settles.
  // Clearing on any settled latestTurn races the gap after ingest (remembered
  // set, activeTurn not yet created) while a prior settled latestTurn still
  // sits on the session — that opened the composer gate mid-stream.
  useEffect(() => {
    const sid = agentSessionId
    if (!sid) return
    const remembered = getRememberedOpenTurn(sid)
    if (!remembered) return
    const active = chatState.activeTurn
    if (active && active.phase !== 'settled') return
    const settled = chatState.latestTurn
    if (
      !active &&
      settled?.phase === 'settled' &&
      settled.turnId === remembered.turnId
    ) {
      clearRememberedOpenTurn(sid)
    }
  }, [
    agentSessionId,
    chatState.activeTurn,
    chatState.latestTurn?.phase,
    chatState.latestTurn?.turnId,
  ])

  return {
    runtime,
    chatState,
    engineSnapshot,
    overlayEpoch,
    interactionResponses,
    respondToInteraction,
  }
}
