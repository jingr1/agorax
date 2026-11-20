import { normalizeMimeType, isImageMimeType, readDataUrlMimeType, stripDataUrlPrefix, buildPortableHistory } from "../lib/conversation-history";
import type { PortableHistoryMessage } from "../lib/conversation-history";
import { useCallback } from "react";
import { createOptimisticMessage } from "../chat-screen-utils";
import { useHermesEngineChatState } from "../hooks/use-hermes-engine-chat";
import { enqueueSessionMessage, queuedMessageCount } from "../lib/session-message-queue";
import { isChatTurnBusyGateOpen } from "../lib/chat-turn-busy-gate";
import { appendHistoryMessage, updateSessionLastMessage } from "../chat-queries";
import { setPendingGeneration } from "../pending-send";
import type { ThinkingLevel } from "../components/chat-composer";
import type { ChatAttachment, ChatMessage } from "../types";
import type { AgentActivity } from "@/stores/chat-activity-store";
import { toast } from "@/components/ui/toast";
import type { Dispatch, SetStateAction, RefObject } from 'react'
import type { QueryClient } from '@tanstack/react-query'
type ControllerContext = {
hermesTurnBusy: boolean
localIsStreamingRef: RefObject<boolean>
hermesEngineChat: ReturnType<typeof useHermesEngineChatState>['chatState']
setQueueVersion: Dispatch<SetStateAction<number>>
thinkingLevelRef: RefObject<ThinkingLevel>
setLocalActivity: (next: AgentActivity) => void
isPortableMode: boolean
queryClient: QueryClient
activeProfileName: string
setSending: Dispatch<SetStateAction<boolean>>
setError: Dispatch<SetStateAction<string | null>>
clearCompletedStreaming: () => void
setWaitingForResponse: (waiting: boolean) => void
activeSendRef: RefObject<{ sessionKey: string; friendlyId: string; clientId: string; } | null>
failsafeTimerRef: RefObject<number | null>
streamFinish: () => void
finalDisplayMessages: ChatMessage[]
streamStart: () => void
startStreaming: (params: { sessionKey: string; friendlyId: string; message: string; history?: PortableHistoryMessage[] | undefined; thinking?: string | undefined; fastMode?: boolean | undefined; attachments?: ChatAttachment[] | undefined; idempotencyKey?: string | undefined; model?: string | undefined; profileName?: string | undefined; }) => Promise<void>
currentModel: string | undefined
workspaceProfileName: string
sending: boolean
}

export function useChatSubmission(context: ControllerContext) {
const { hermesTurnBusy, localIsStreamingRef, hermesEngineChat, setQueueVersion, thinkingLevelRef, setLocalActivity, isPortableMode, queryClient, activeProfileName, setSending, setError, clearCompletedStreaming, setWaitingForResponse, activeSendRef, failsafeTimerRef, streamFinish, finalDisplayMessages, streamStart, startStreaming, currentModel, workspaceProfileName, sending } = context
const sendMessage = useCallback(
    function sendMessage(
      sessionKey: string,
      friendlyId: string,
      body: string,
      attachments: Array<ChatAttachment> = [],
      fastMode = false,
      skipOptimistic = false,
      existingClientId = '',
    ) {
      // Hard gate: while the previous turn is open, never ingest a new user row.
      // Composer should have queued already; this catches drain races / direct calls.
      if (
        isChatTurnBusyGateOpen({
          agentSessionId: sessionKey,
          turnBusy: hermesTurnBusy,
          localIsStreaming: localIsStreamingRef.current,
          sending,
          activeTurnPhase: hermesEngineChat.activeTurn?.phase ?? null,
        })
      ) {
        const entry = enqueueSessionMessage(sessionKey, {
          text: body,
          attachments,
        })
        if (entry) {
          setQueueVersion((version) => version + 1)
          toast(
            `Queued (${queuedMessageCount(sessionKey)}) — sends after this reply`,
            { type: 'success' },
          )
        }
        return
      }

      // Read from ref so we always get the latest value without capturing it in deps
      const currentThinkingLevel = thinkingLevelRef.current
      setLocalActivity('reading')
      const normalizedAttachments = attachments.map((attachment) => ({
        ...attachment,
        id: attachment.id ?? crypto.randomUUID(),
      }))

      // Inject text/file attachment content directly into the message body.
      // Servers reliably forward text in the message body; file attachments
      // may be silently dropped for non-image types.
      const textBlocks = normalizedAttachments
        .filter((a) => {
          const mime =
            normalizeMimeType(a.contentType ?? '') ||
            readDataUrlMimeType(a.dataUrl ?? '')
          return !isImageMimeType(mime) && (a.dataUrl ?? '').length > 0
        })
        .map((a) => {
          const raw = a.dataUrl ?? ''
          const content = raw.startsWith('data:')
            ? atob(raw.split(',')[1] ?? '')
            : raw
          return `\n\n<attachment name="${a.name ?? 'file'}">\n${content}\n</attachment>`
        })
      const enrichedBody = body + textBlocks.join('')

      let optimisticClientId = existingClientId
      if (!skipOptimistic) {
        const { clientId, optimisticMessage } = createOptimisticMessage(
          body,
          normalizedAttachments,
        )
        optimisticClientId = clientId
        // Hermes 1:1 list is Engine-only. Writing the user into RQ *before*
        // ingest lets busy reconcile admit a follow-up past the hard gate.
        // Portable still needs the RQ optimistic row as its list source.
        if (isPortableMode) {
          appendHistoryMessage(
            queryClient,
            friendlyId,
            sessionKey,
            optimisticMessage,
          )
          updateSessionLastMessage(
            queryClient,
            activeProfileName,
            sessionKey,
            friendlyId,
            optimisticMessage,
          )
        }
      }

      setPendingGeneration(true, { sessionKey, friendlyId })
      setSending(true)
      setError(null)
      clearCompletedStreaming()
      setWaitingForResponse(true)
      activeSendRef.current = {
        sessionKey,
        friendlyId,
        clientId: optimisticClientId,
      }

      // Failsafe: clear waitingForResponse after 120s no matter what
      // Prevents infinite spinner if SSE/idle detection both fail
      if (failsafeTimerRef.current) {
        window.clearTimeout(failsafeTimerRef.current)
      }
      failsafeTimerRef.current = window.setTimeout(() => {
        streamFinish()
      }, 120_000)

      // Send a compatibility shape for attachment parsing.
      // Different server/channel versions read different keys.
      const payloadAttachments = normalizedAttachments.map((attachment) => {
        const mimeType =
          normalizeMimeType(attachment.contentType) ||
          readDataUrlMimeType(attachment.dataUrl)
        const isImage = isImageMimeType(mimeType)
        // For text/file attachments, dataUrl holds raw text (not a base64 data URL).
        // We must base64-encode it so the server can build a valid data: URI.
        const rawDataUrl = attachment.dataUrl ?? ''
        let encodedContent: string
        let finalDataUrl: string
        if (!isImage && !rawDataUrl.startsWith('data:')) {
          encodedContent = btoa(unescape(encodeURIComponent(rawDataUrl)))
          finalDataUrl = mimeType
            ? `data:${mimeType};base64,${encodedContent}`
            : `data:text/plain;base64,${encodedContent}`
        } else {
          encodedContent = stripDataUrlPrefix(rawDataUrl)
          finalDataUrl = rawDataUrl
        }
        return {
          id: attachment.id,
          name: attachment.name,
          fileName: attachment.name,
          contentType: mimeType || undefined,
          mimeType: mimeType || undefined,
          mediaType: mimeType || undefined,
          type: isImage ? 'image' : 'file',
          content: encodedContent,
          data: encodedContent,
          base64: encodedContent,
          dataUrl: finalDataUrl,
          size: attachment.size,
        }
      })
      const history = buildPortableHistory(finalDisplayMessages)

      try {
        streamStart()
      } catch (e) {
        if (import.meta.env.DEV) {
          console.warn('[chat] streamStart error (non-fatal):', e)
        }
      }

      void startStreaming({
        sessionKey,
        friendlyId,
        message: enrichedBody,
        history,
        attachments:
          payloadAttachments.length > 0 ? payloadAttachments : undefined,
        thinking:
          currentThinkingLevel === 'off' ? undefined : currentThinkingLevel,
        fastMode,
        model: currentModel || undefined,
        idempotencyKey: optimisticClientId || crypto.randomUUID(),
        profileName: workspaceProfileName || activeProfileName || undefined,
      }).catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : String(err)
        if (import.meta.env.DEV) {
          console.warn('[chat] send-stream failed', messageText)
        }
      })
    },
    [
      clearCompletedStreaming,
      currentModel,
      finalDisplayMessages,
      hermesEngineChat.activeTurn?.phase,
      hermesTurnBusy,
      isPortableMode,
      queryClient,
      sending,
      setLocalActivity,
      startStreaming,
      streamFinish,
      streamStart,
    ],
  )
return { sendMessage }
}
