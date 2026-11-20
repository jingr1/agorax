import { useCallback, useEffect } from "react";
import { useHermesEngineChatState } from "../hooks/use-hermes-engine-chat";
import { clearSessionQueue, dequeueSessionMessage, enqueueSessionMessage, queuedMessageCount } from "../lib/session-message-queue";
import { isChatTurnBusyGateOpen } from "../lib/chat-turn-busy-gate";
import type { ChatComposerAttachment, ChatComposerHelpers } from "../components/chat-composer";
import type { ChatAttachment } from "../types";
import { toast } from "@/components/ui/toast";
import type { Dispatch, SetStateAction, RefObject } from 'react'
import type { QueryClient } from '@tanstack/react-query'
type ControllerContext = {
queueSessionKey: string
setQueueVersion: Dispatch<SetStateAction<number>>
activeSteerRunId: string | null
workspaceProfileName: string
activeProfileName: string
abortActiveStreamRef: RefObject<() => void>
hermesTurnBusy: boolean
isCompacting: boolean
hermesEngineChat: ReturnType<typeof useHermesEngineChatState>['chatState']
wasBusyForQueueRef: RefObject<boolean>
mountDrainKeyRef: RefObject<string | null>
sendMessage: (sessionKey: string, friendlyId: string, body: string, attachments?: ChatAttachment[], fastMode?: boolean, skipOptimistic?: boolean, existingClientId?: string) => void
activeFriendlyId: string
localIsStreaming: boolean
sending: boolean
}

export function useChatFollowUps(context: ControllerContext) {
const { queueSessionKey, setQueueVersion, activeSteerRunId, workspaceProfileName, activeProfileName, abortActiveStreamRef, hermesTurnBusy, isCompacting, hermesEngineChat, wasBusyForQueueRef, mountDrainKeyRef, sendMessage, activeFriendlyId, localIsStreaming, sending } = context
const handleQueueFromComposer = useCallback(
    (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => {
      if (!queueSessionKey || queueSessionKey === 'new') {
        toast('Open a session first', { type: 'error' })
        return
      }
      const entry = enqueueSessionMessage(queueSessionKey, {
        text: body,
        attachments,
      })
      if (!entry) {
        toast('Could not queue message', { type: 'error' })
        return
      }
      helpers.reset()
      setQueueVersion((version) => version + 1)
      toast(
        `Queued (${queuedMessageCount(queueSessionKey)}) — sends after this reply`,
        { type: 'success' },
      )
    },
    [queueSessionKey],
  )

const handleClearQueue = useCallback(() => {
    if (!queueSessionKey || queueSessionKey === 'new') return
    clearSessionQueue(queueSessionKey)
    setQueueVersion((version) => version + 1)
    toast('Queue cleared', { type: 'success' })
  }, [queueSessionKey])

const handleSteerFromComposer = useCallback(
    async (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => {
      const text = body.trim()
      if (!text && attachments.length === 0) return

      // Attachments aren't supported on the Hermes steer API yet — queue instead.
      if (attachments.length > 0 || !activeSteerRunId) {
        if (!queueSessionKey || queueSessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return
        }
        const entry = enqueueSessionMessage(queueSessionKey, {
          text: text || '(attachment)',
          attachments,
        })
        if (entry) {
          helpers.reset()
          setQueueVersion((version) => version + 1)
          toast(
            activeSteerRunId
              ? 'Attachments queued (steer is text-only)'
              : 'No live run — queued for next turn',
            { type: 'info' },
          )
        }
        return
      }

      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(activeSteerRunId)}/steer`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              profileName: workspaceProfileName || activeProfileName || undefined,
            }),
          },
        )
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          fallback?: string
        }
        if (!res.ok || !data.ok) {
          if (
            data.fallback === 'queue' ||
            res.status === 409 ||
            !queueSessionKey ||
            queueSessionKey === 'new'
          ) {
            if (queueSessionKey && queueSessionKey !== 'new') {
              enqueueSessionMessage(queueSessionKey, { text })
              setQueueVersion((version) => version + 1)
              helpers.reset()
              toast('Steer unavailable — queued for next turn', {
                type: 'warning',
              })
              return
            }
          }
          toast(data.error || 'Steer failed', { type: 'error' })
          return
        }
        helpers.reset()
        toast('Steered current reply', { type: 'success' })
      } catch (err) {
        toast(
          `Steer failed. ${err instanceof Error ? err.message : String(err)}`,
          { type: 'error' },
        )
      }
    },
    [activeProfileName, activeSteerRunId, queueSessionKey, workspaceProfileName],
  )

const handleInterruptSendFromComposer = useCallback(
    (
      body: string,
      attachments: Array<ChatComposerAttachment>,
      helpers: ChatComposerHelpers,
    ) => {
      if (!queueSessionKey || queueSessionKey === 'new') {
        toast('Open a session first', { type: 'error' })
        return
      }
      const entry = enqueueSessionMessage(queueSessionKey, {
        text: body,
        attachments,
      })
      if (!entry) {
        toast('Could not queue interrupt message', { type: 'error' })
        return
      }
      helpers.reset()
      setQueueVersion((version) => version + 1)
      abortActiveStreamRef.current()
      toast('Interrupted — follow-up will send next', { type: 'success' })
    },
    [queueSessionKey],
  )

useEffect(() => {
    const gateOpen = isChatTurnBusyGateOpen({
      agentSessionId: queueSessionKey,
      turnBusy: hermesTurnBusy || isCompacting,
      localIsStreaming,
      sending,
      activeTurnPhase: hermesEngineChat.activeTurn?.phase ?? null,
    })
    if (gateOpen) {
      wasBusyForQueueRef.current = true
      return
    }
    if (!queueSessionKey || queueSessionKey === 'new') return

    const sessionChanged = mountDrainKeyRef.current !== queueSessionKey
    mountDrainKeyRef.current = queueSessionKey
    const wasBusy = wasBusyForQueueRef.current
    wasBusyForQueueRef.current = false
    if (!wasBusy && !sessionChanged) return
    if (queuedMessageCount(queueSessionKey) === 0) return

    const next = dequeueSessionMessage(queueSessionKey)
    if (!next) return
    setQueueVersion((version) => version + 1)

    const attachments: Array<ChatAttachment> = (next.attachments ?? []).map(
      (attachment) => ({
        id: attachment.id ?? crypto.randomUUID(),
        name: attachment.name ?? 'file',
        contentType: attachment.contentType ?? 'application/octet-stream',
        size: attachment.size ?? 0,
        dataUrl: attachment.dataUrl,
        previewUrl: attachment.previewUrl,
        kind: attachment.kind,
      }),
    )
    sendMessage(
      queueSessionKey,
      activeFriendlyId || queueSessionKey,
      next.text,
      attachments,
      false,
    )
  }, [
    activeFriendlyId,
    hermesEngineChat.activeTurn?.phase,
    hermesTurnBusy,
    isCompacting,
    localIsStreaming,
    queueSessionKey,
    sendMessage,
    sending,
  ])
return { handleQueueFromComposer, handleClearQueue, handleSteerFromComposer, handleInterruptSendFromComposer }
}
