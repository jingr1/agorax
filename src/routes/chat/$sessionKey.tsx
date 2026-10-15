import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  chatQueryKeys,
  fetchHistory,
  moveHistoryMessages,
  reconcileSessionDraft,
} from '../../screens/chat/chat-queries'
import { writeLastSession } from '../../screens/chat/last-session'
import { ChatRouteLoading } from '../../screens/chat/chat-route-loading'
import { useProfiles } from '../../screens/chat/hooks/use-profiles'
import { prefetchProfileWorkspace } from '@/lib/workspace-client'
import { useAgentStore } from '@/stores/agent-store'
import { fetchAgents } from '@/lib/agent-api'
import { ErrorBoundary } from '@/components/error-boundary'

const loadChatScreen = () =>
  import('../../screens/chat/chat-screen').then((module) => ({
    default: module.ChatScreen,
  }))

// Warm the chat chunk as soon as this module evaluates (route match), not
// only after Suspense mounts — cuts the spinner→shell gap on cold navigations.
void loadChatScreen()
// File explorer is nested-lazy inside ChatScreen; warm it here so the files
// tree request is not gated on that second chunk download.
void import('../../components/file-explorer')

const ChatScreen = lazy(loadChatScreen)

export const Route = createFileRoute('/chat/$sessionKey')({
  component: ChatRoute,
  pendingComponent: ChatRouteLoading,
  // Disable SSR to prevent hydration mismatches from async data
  ssr: false,
  errorComponent: function ChatError({ error, reset }) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center bg-primary-50">
        <div className="max-w-md">
          <div className="mb-4 text-5xl">💬</div>
          <h2 className="text-xl font-semibold text-primary-900 mb-3">
            Chat Error
          </h2>
          <p className="text-sm text-primary-600 mb-6">
            {error instanceof Error
              ? error.message
              : 'Failed to load chat session'}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={reset}
              className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={() => {
                if (typeof window !== 'undefined')
                  window.location.href = '/chat'
              }}
              className="px-4 py-2 border border-primary-300 text-primary-700 rounded-lg hover:bg-primary-100 transition-colors"
            >
              Return to Main
            </button>
          </div>
        </div>
      </div>
    )
  },
})

function ChatRoute() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { activeProfileName } = useProfiles()
  const [forcedSession, setForcedSession] = useState<{
    friendlyId: string
    sessionKey: string
  } | null>(null)
  const params = Route.useParams()
  const activeFriendlyId =
    typeof params.sessionKey === 'string' ? params.sessionKey : 'main'
  const isNewChat = activeFriendlyId === 'new'
  const forcedSessionKey =
    forcedSession?.friendlyId === activeFriendlyId
      ? forcedSession.sessionKey
      : undefined

  // Seed agents on first mount and keep the active agent in sync with the
  // current Hermes profile so the unified Agents sidebar highlights correctly.
  useEffect(() => {
    let cancelled = false
    const syncAgents = async () => {
      if (useAgentStore.getState().agents.length > 0) {
        syncActiveAgent()
        return
      }
      try {
        const data = await fetchAgents()
        if (cancelled) return
        useAgentStore.getState().setAgents(data.agents)
        syncActiveAgent()
      } catch {
        // Ignore — the sidebar will show an empty state if agents fail to load.
      }
    }
    const syncActiveAgent = () => {
      const state = useAgentStore.getState()
      if (state.activeAgentId || !activeProfileName) return
      const matchingHermesAgent = state.agents.find(
        (agent) =>
          agent.runtime === 'hermes' &&
          (agent.runtimeConfig.profile ?? agent.agentId) === activeProfileName,
      )
      if (matchingHermesAgent) {
        state.setActiveAgentId(matchingHermesAgent.agentId)
      }
    }
    void syncAgents()
    return () => {
      cancelled = true
    }
  }, [activeProfileName])

  // Clear history cache when navigating to new chat
  useEffect(() => {
    if (isNewChat) {
      queryClient.removeQueries({ queryKey: ['chat', 'history', 'new', 'new'] })
    }
  }, [isNewChat, queryClient])

  // Prefetch history while the chat chunk is still downloading so the first
  // ChatScreen paint often already has messages (no second skeleton wait).
  useEffect(() => {
    if (isNewChat || !activeFriendlyId || activeFriendlyId === 'main') return
    const historyKey = chatQueryKeys.history(activeFriendlyId, activeFriendlyId)
    void queryClient.prefetchQuery({
      queryKey: historyKey,
      queryFn: () =>
        fetchHistory({
          sessionKey: activeFriendlyId,
          friendlyId: activeFriendlyId,
          profile: activeProfileName,
        }),
      staleTime: 10_000,
    })
  }, [activeFriendlyId, activeProfileName, isNewChat, queryClient])

  // Prefetch workspace + shallow files tree at route level — explorer mounts
  // later via nested lazy(), so warm the cache (path-keyed, depth 0) early.
  useEffect(() => {
    if (!activeProfileName) return
    void prefetchProfileWorkspace(queryClient, activeProfileName)
  }, [activeProfileName, queryClient])

  const handleSessionResolved = useCallback(
    function handleSessionResolved(payload: {
      friendlyId: string
      sessionKey: string
    }) {
      const sourceFriendlyId = activeFriendlyId
      const sourceSessionKey = forcedSessionKey ?? activeFriendlyId
      moveHistoryMessages(
        queryClient,
        sourceFriendlyId,
        sourceSessionKey,
        payload.friendlyId,
        payload.sessionKey,
      )
      reconcileSessionDraft(
        queryClient,
        activeProfileName,
        sourceFriendlyId,
        sourceSessionKey,
        payload.friendlyId,
        payload.sessionKey,
      )
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
      setForcedSession({
        friendlyId: payload.friendlyId,
        sessionKey: payload.sessionKey,
      })
      writeLastSession(payload.friendlyId, activeProfileName)
      navigate({
        to: '/chat/$sessionKey',
        params: { sessionKey: payload.friendlyId },
        replace: true,
      })
    },
    [
      activeFriendlyId,
      activeProfileName,
      forcedSessionKey,
      navigate,
      queryClient,
    ],
  )

  return (
    <ErrorBoundary>
      <Suspense fallback={<ChatRouteLoading />}>
        <ChatScreen
          activeFriendlyId={activeFriendlyId}
          isNewChat={isNewChat}
          forcedSessionKey={forcedSessionKey}
          onSessionResolved={
            isNewChat || activeFriendlyId === 'main'
              ? handleSessionResolved
              : undefined
          }
        />
      </Suspense>
    </ErrorBoundary>
  )
}
