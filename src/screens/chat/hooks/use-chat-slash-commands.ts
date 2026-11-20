import { exportConversationTranscript } from "../lib/conversation-export";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { textFromMessage } from "../utils";
import { findLastUserMessage, historyIndexOf, keepCountForEdit } from "../session-fork";
import { enqueueSessionMessage, queuedMessageCount } from "../lib/session-message-queue";
import { clearHistoryMessages } from "../chat-queries";
import { CHAT_OPEN_SETTINGS_EVENT } from "../chat-events";
import type { ChatComposerHelpers } from "../components/chat-composer";
import type { ChatAttachment, ChatMessage } from "../types";
import { toast } from "@/components/ui/toast";
import type { Dispatch, SetStateAction, RefObject } from 'react'
import type { QueryClient } from '@tanstack/react-query'

type ChatSlashCommandsContext = {
  navigate: ReturnType<typeof useNavigate>
  forcedSessionKey: string | undefined
  resolvedSessionKey: string
  activeSessionKey: string
  activeFriendlyId: string
  queryClient: QueryClient
  finalDisplayMessages: ChatMessage[]
  canTruncateSession: boolean
  UNAVAILABLE_TRUNCATE_MSG: "Not available on this Hermes build (needs upstream session_truncate)"
  interactionBusy: boolean
  truncateCurrentSession: (keepCount: number) => Promise<number>
  sendMessage: (sessionKey: string, friendlyId: string, body: string, attachments?: ChatAttachment[], fastMode?: boolean, skipOptimistic?: boolean, existingClientId?: string) => void
  setQueueVersion: Dispatch<SetStateAction<number>>
  abortActiveStreamRef: RefObject<() => void>
  localStreamingRunId: string | null
  streamingRunId: string | null
  workspaceProfileName: string
  activeProfileName: string
  canCompressSession: boolean
  UNAVAILABLE_COMPRESS_MSG: "Not available on this Hermes build (needs upstream session_compress)"
  setIsCompacting: Dispatch<SetStateAction<boolean>>
  refreshHistoryRef: RefObject<() => void>
  setBtwCard: Dispatch<SetStateAction<{ question: string; answer?: string | undefined; error?: string | undefined; loading: boolean; } | null>>
  setBackgroundTasks: Dispatch<SetStateAction<{ taskId: string; status: "error" | "running" | "done"; prompt: string; sessionId: string; answer?: string | undefined; error?: string | undefined; }[]>>
  activeIsRealtimeStreaming: boolean
  sending: boolean
}

const commandHelpers: ChatComposerHelpers = {
  reset() {},
  setValue() {},
  setAttachments() {},
}

export function useChatSlashCommands(context: ChatSlashCommandsContext) {
  const { navigate, forcedSessionKey, resolvedSessionKey, activeSessionKey, activeFriendlyId, queryClient, finalDisplayMessages, canTruncateSession, UNAVAILABLE_TRUNCATE_MSG, interactionBusy, truncateCurrentSession, sendMessage, setQueueVersion, abortActiveStreamRef, localStreamingRunId, streamingRunId, workspaceProfileName, activeProfileName, canCompressSession, UNAVAILABLE_COMPRESS_MSG, setIsCompacting, refreshHistoryRef, setBtwCard, setBackgroundTasks, activeIsRealtimeStreaming, sending } = context
  return useCallback(
    (command: string) => {
      const trimmedCommand = command.trim()
      if (!trimmedCommand.startsWith('/')) return false

      if (trimmedCommand === '/new') {
        // Use the explicit 'new' session sentinel rather than '/chat' alone.
        // The /chat index route redirects to the last-active session via
        // localStorage, so navigating to '/chat' would land in the previous
        // chat instead of opening a fresh one. See #300.
        navigate({ to: '/chat/$sessionKey', params: { sessionKey: 'new' } })
        return true
      }

      if (trimmedCommand === '/clear') {
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        clearHistoryMessages(queryClient, activeFriendlyId, sessionKey)
        toast('Chat cleared', { type: 'success' })
        return true
      }

      if (trimmedCommand === '/model' || trimmedCommand === '/skin') {
        window.dispatchEvent(
          new CustomEvent(CHAT_OPEN_SETTINGS_EVENT, {
            detail: {
              section: trimmedCommand === '/skin' ? 'appearance' : 'model',
            },
          }),
        )
        return true
      }

      if (trimmedCommand === '/skills') {
        navigate({ to: '/skills' })
        return true
      }

      if (trimmedCommand === '/save') {
        const exported = exportConversationTranscript({
          sessionLabel: activeFriendlyId || 'conversation',
          messages: finalDisplayMessages,
        })
        if (exported) {
          toast('Conversation exported', { type: 'success' })
        }
        return true
      }

      if (trimmedCommand === '/retry') {
        if (!canTruncateSession) {
          toast(UNAVAILABLE_TRUNCATE_MSG, { type: 'error' })
          return true
        }
        if (interactionBusy) {
          toast('Wait for the current reply to finish', { type: 'error' })
          return true
        }
        const lastUser = findLastUserMessage(finalDisplayMessages)
        const historyIndex = lastUser ? historyIndexOf(lastUser) : null
        const userText = lastUser ? textFromMessage(lastUser).trim() : ''
        if (!lastUser || historyIndex === null || !userText) {
          toast('No previous message to retry', { type: 'error' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        const friendlyId = activeFriendlyId || sessionKey
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        void (async () => {
          try {
            await truncateCurrentSession(keepCountForEdit(historyIndex))
            sendMessage(sessionKey, friendlyId, userText, [], false)
          } catch (err) {
            toast(
              `Retry failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      if (trimmedCommand === '/undo') {
        if (!canTruncateSession) {
          toast(UNAVAILABLE_TRUNCATE_MSG, { type: 'error' })
          return true
        }
        if (interactionBusy) {
          toast('Wait for the current reply to finish', { type: 'error' })
          return true
        }
        const lastUser = findLastUserMessage(finalDisplayMessages)
        const historyIndex = lastUser ? historyIndexOf(lastUser) : null
        if (historyIndex === null) {
          toast('Nothing to undo', { type: 'error' })
          return true
        }
        void (async () => {
          try {
            const removed = await truncateCurrentSession(
              keepCountForEdit(historyIndex),
            )
            toast(`Undid ${removed} message${removed === 1 ? '' : 's'}`, {
              type: 'success',
            })
          } catch (err) {
            toast(
              `Undo failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      if (trimmedCommand === '/queue' || trimmedCommand.startsWith('/queue ')) {
        const rest = trimmedCommand.slice('/queue'.length).trim()
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!rest) {
          const count =
            sessionKey && sessionKey !== 'new'
              ? queuedMessageCount(sessionKey)
              : 0
          toast(
            count === 0
              ? 'Queue is empty — /queue <text> to add a follow-up'
              : count === 1
                ? '1 message queued'
                : `${count} messages queued`,
            { type: 'info' },
          )
          return true
        }
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        const busy = interactionBusy
        if (!busy) {
          sendMessage(
            sessionKey,
            activeFriendlyId || sessionKey,
            rest,
            [],
            false,
          )
          return true
        }
        const entry = enqueueSessionMessage(sessionKey, { text: rest })
        if (!entry) {
          toast('Could not queue message', { type: 'error' })
          return true
        }
        setQueueVersion((version) => version + 1)
        toast(
          `Queued (${queuedMessageCount(sessionKey)}) — sends after this reply`,
          { type: 'success' },
        )
        return true
      }

      if (
        trimmedCommand === '/interrupt' ||
        trimmedCommand.startsWith('/interrupt ')
      ) {
        const rest = trimmedCommand.slice('/interrupt'.length).trim()
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        const busy = interactionBusy
        if (!busy) {
          if (!rest) {
            toast('Nothing to interrupt', { type: 'info' })
            return true
          }
          if (!sessionKey || sessionKey === 'new') {
            toast('Open a session first', { type: 'error' })
            return true
          }
          sendMessage(
            sessionKey,
            activeFriendlyId || sessionKey,
            rest,
            [],
            false,
          )
          return true
        }
        if (rest) {
          if (!sessionKey || sessionKey === 'new') {
            toast('Open a session first', { type: 'error' })
            return true
          }
          // Queue first so drain after cancel picks it up.
          enqueueSessionMessage(sessionKey, { text: rest })
          setQueueVersion((version) => version + 1)
        }
        abortActiveStreamRef.current()
        toast(
          rest
            ? 'Interrupted — queued follow-up will send next'
            : 'Interrupted',
          { type: 'success' },
        )
        return true
      }

      if (trimmedCommand === '/steer' || trimmedCommand.startsWith('/steer ')) {
        const rest = trimmedCommand.slice('/steer'.length).trim()
        if (!rest) {
          toast('Usage: /steer <text>', { type: 'info' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        const runId = localStreamingRunId || streamingRunId || null
        const busy = interactionBusy
        if (!busy || !runId) {
          if (!sessionKey || sessionKey === 'new') {
            toast('Open a session first', { type: 'error' })
            return true
          }
          if (!busy) {
            sendMessage(
              sessionKey,
              activeFriendlyId || sessionKey,
              rest,
              [],
              false,
            )
            return true
          }
          enqueueSessionMessage(sessionKey, { text: rest })
          setQueueVersion((version) => version + 1)
          toast('No live run — queued for next turn', { type: 'info' })
          return true
        }
        void (async () => {
          try {
            const res = await fetch(
              `/api/runs/${encodeURIComponent(runId)}/steer`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: rest, profileName: workspaceProfileName || activeProfileName || undefined }),
              },
            )
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              fallback?: string
            }
            if (!res.ok || !data.ok) {
              if (sessionKey && sessionKey !== 'new') {
                enqueueSessionMessage(sessionKey, { text: rest })
                setQueueVersion((version) => version + 1)
                toast('Steer unavailable — queued for next turn', {
                  type: 'warning',
                })
                return
              }
              toast(data.error || 'Steer failed', { type: 'error' })
              return
            }
            toast('Steered current reply', { type: 'success' })
          } catch (err) {
            toast(
              `Steer failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      if (
        trimmedCommand === '/compress' ||
        trimmedCommand === '/compact' ||
        trimmedCommand.startsWith('/compress ') ||
        trimmedCommand.startsWith('/compact ')
      ) {
        if (!canCompressSession) {
          toast(UNAVAILABLE_COMPRESS_MSG, { type: 'error' })
          return true
        }
        const focusTopic = trimmedCommand
          .replace(/^\/(?:compress|compact)\s*/i, '')
          .trim()
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        if (interactionBusy) {
          toast('Wait for the current reply to finish', { type: 'error' })
          return true
        }
        setIsCompacting(true)
        void (async () => {
          try {
            const res = await fetch(
              `/api/sessions/${encodeURIComponent(sessionKey)}/compress`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  focusTopic: focusTopic || undefined,
                  keepCount: 6,
                  profileName:
                    workspaceProfileName || activeProfileName || undefined,
                }),
              },
            )
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              beforeCount?: number
              afterCount?: number
            }
            if (!res.ok || !data.ok) {
              toast(data.error || 'Compress failed', { type: 'error' })
              return
            }
            toast(
              `Compressed ${data.beforeCount ?? '?'} → ${data.afterCount ?? '?'} messages`,
              { type: 'success' },
            )
            refreshHistoryRef.current()
          } catch (err) {
            toast(
              `Compress failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          } finally {
            setIsCompacting(false)
          }
        })()
        return true
      }

      if (trimmedCommand === '/btw' || trimmedCommand.startsWith('/btw ')) {
        const question = trimmedCommand.slice('/btw'.length).trim()
        if (!question) {
          toast('Usage: /btw <question>', { type: 'info' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        setBtwCard({ question, loading: true })
        void (async () => {
          try {
            const res = await fetch('/api/btw', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: sessionKey,
                question,
                profileName: workspaceProfileName || activeProfileName || undefined,
              }),
            })
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              answer?: string
            }
            if (!res.ok || !data.ok || !data.answer) {
              setBtwCard({
                question,
                loading: false,
                error: data.error || 'Side question failed',
              })
              return
            }
            setBtwCard({ question, answer: data.answer, loading: false })
          } catch (err) {
            setBtwCard({
              question,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
        return true
      }

      if (
        trimmedCommand === '/bg' ||
        trimmedCommand === '/background' ||
        trimmedCommand.startsWith('/bg ') ||
        trimmedCommand.startsWith('/background ')
      ) {
        const prompt = trimmedCommand
          .replace(/^\/(?:bg|background)\s*/i, '')
          .trim()
        if (!prompt) {
          toast('Usage: /bg <prompt>', { type: 'info' })
          return true
        }
        const sessionKey =
          forcedSessionKey ||
          resolvedSessionKey ||
          activeSessionKey ||
          activeFriendlyId
        if (!sessionKey || sessionKey === 'new') {
          toast('Open a session first', { type: 'error' })
          return true
        }
        void (async () => {
          try {
            const res = await fetch('/api/background', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: sessionKey,
                prompt,
                profileName: workspaceProfileName || activeProfileName || undefined,
              }),
            })
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean
              error?: string
              taskId?: string
              sessionId?: string
            }
            if (!res.ok || !data.ok || !data.taskId) {
              toast(data.error || 'Background task failed to start', {
                type: 'error',
              })
              return
            }
            setBackgroundTasks((prev) => [
              {
                taskId: data.taskId!,
                status: 'running',
                prompt,
                sessionId: data.sessionId || '',
              },
              ...prev,
            ])
            toast('Background task started', { type: 'success' })
          } catch (err) {
            toast(
              `Background failed. ${err instanceof Error ? err.message : String(err)}`,
              { type: 'error' },
            )
          }
        })()
        return true
      }

      return false
    },
    [
      activeFriendlyId,
      activeIsRealtimeStreaming,
      activeProfileName,
      activeSessionKey,
      canCompressSession,
      canTruncateSession,
      finalDisplayMessages,
      forcedSessionKey,
      localStreamingRunId,
      navigate,
      queryClient,
      resolvedSessionKey,
      interactionBusy,
      sending,
      sendMessage,
      streamingRunId,
      truncateCurrentSession,
      workspaceProfileName,
    ],
  )
}
