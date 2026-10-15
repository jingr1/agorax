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
  type InteractionResponseState,
} from '@agorax/agent-activity-core'
import {
  getHermesChatRuntime,
  selectHermesChatState,
} from '@/stores/hermes-chat-runtime'
import type { ManagedAgentInteractionResponseInput } from '../components/managed-agent-interaction-panel'
import type { ChatMessage } from '../types'

export function useHermesEngineChatState(input: {
  workspaceId: string
  agentSessionId: string | null
  profileName?: string | null
  /** UI optimistic sending — OR'd with Engine selectSessionIsSubmitting. */
  isSubmitting?: boolean
  /** Gateway history — reconciled into Engine when idle. */
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
    async (input: ManagedAgentInteractionResponseInput) => {
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

  const historyRevisionRef = useRef(0)
  useEffect(() => {
    const sid = agentSessionId
    if (!sid || input.historyReady === false) return
    if (!input.historyMessages) return
    historyRevisionRef.current += 1
    runtime.ensureSessionHydrated(sid)
    runtime.reconcileHistory(
      sid,
      input.historyMessages,
      historyRevisionRef.current,
    )
  }, [
    agentSessionId,
    input.historyMessages,
    input.historyReady,
    runtime,
    // Re-attempt after settle when a previous call no-op'd on turnBusy.
    chatState.turnBusy,
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
