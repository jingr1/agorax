import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Suspense, lazy, useEffect, useState } from 'react'
import { z } from 'zod'
import { ChatRouteLoading } from '../../../screens/chat/chat-route-loading'
import {
  sessionBelongsToAgent,
  useAgentStore,
} from '../../../stores/agent-store'
import { fetchAgents, fetchSessionsForAgent } from '../../../lib/agent-api'
import { ErrorBoundary } from '@/components/error-boundary'
import { resolveSessionForProfile } from '../../../screens/chat/last-session'
import { pickChatAgentId } from '../../../screens/chat/pick-chat-agent'
import {
  chatQueryKeys,
  fetchSessions,
} from '../../../screens/chat/chat-queries'
import type { SessionMeta } from '../../../screens/chat/types'
import { useQueryClient } from '@tanstack/react-query'

const loadAgentWorkspace = () =>
  import('../../../screens/chat/agent-workspace').then((module) => ({
    default: module.AgentWorkspace,
  }))

// Warm the workspace chunk on route match so agent switches do not pay a
// second Suspense spinner after the first chat paint.
void loadAgentWorkspace()

const AgentWorkspace = lazy(loadAgentWorkspace)

/** True when registry is already in store — agent switches remount without a blank loader. */
export function canPaintChatAgentShell(): boolean {
  return useAgentStore.getState().agents.length > 0
}

const chatAgentSearchSchema = z.object({
  session: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/chat/agent/$agentId')({
  component: ChatAgentRoute,
  pendingComponent: ChatRouteLoading,
  ssr: false,
  validateSearch: chatAgentSearchSchema,
  errorComponent: function ChatAgentError({ error, reset }) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center bg-primary-50">
        <div className="max-w-md">
          <div className="mb-4 text-5xl">💬</div>
          <h2 className="text-xl font-semibold text-primary-900 mb-3">
            Agent Workspace Error
          </h2>
          <p className="text-sm text-primary-600 mb-6">
            {error instanceof Error
              ? error.message
              : 'Failed to load agent workspace'}
          </p>
          <button
            onClick={reset}
            className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  },
})

function ChatAgentRoute() {
  const params = Route.useParams()
  const search = useSearch({ from: Route.id })
  const navigate = useNavigate({ from: Route.id })
  const queryClient = useQueryClient()
  const agentId = typeof params.agentId === 'string' ? params.agentId : ''
  const setActiveAgentId = useAgentStore((s) => s.setActiveAgentId)
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  // Cold /chat entry waits for the registry. Agent↔agent navigations remount
  // this route; seeded useState resets — init from store.agents so the shell
  // stays and only the session pane swaps.
  const [seeded, setSeeded] = useState(() => canPaintChatAgentShell())

  // Seed agents once, then keep activeAgentId in sync with the URL agent param.
  // Do NOT re-run this when only ?session= changes — clearing the session on
  // agent switch used to re-apply the *old* URL agentId and wipe the click.
  useEffect(() => {
    let cancelled = false

    const resolveSessionForAgent = async (
      id: string,
    ): Promise<string | null> => {
      const fromUrl = search.session?.trim()
      const store = useAgentStore.getState()

      const agent = store.agents.find((entry) => entry.agentId === id)
      if (!agent) return null

      if (agent.runtime === 'hermes') {
        if (fromUrl && fromUrl !== 'new') return fromUrl
        const profile = agent.runtimeConfig.profile ?? agent.agentId
        let sessions = queryClient.getQueryData<Array<SessionMeta>>(
          chatQueryKeys.sessionsForProfile(profile),
        )
        let sessionsLoaded = sessions !== undefined
        if (!sessionsLoaded) {
          try {
            sessions = await fetchSessions(profile)
            if (cancelled) return null
            queryClient.setQueryData(
              chatQueryKeys.sessionsForProfile(profile),
              sessions,
            )
            sessionsLoaded = true
          } catch {
            if (cancelled) return null
            sessions = []
            sessionsLoaded = false
          }
        }
        const resolved = resolveSessionForProfile(sessions, profile, {
          sessionsLoaded,
        })
        return resolved === 'new' ? null : resolved
      }

      // Managed (Agorax-style): URL only if owned; else in-memory last; else
      // localStorage last that appears in this agent's list.
      const cached = store.sessionsByAgentId.get(id) ?? []
      const knownIds = new Set(cached.map((session) => session.sessionId))
      const sessionsLoaded = store.sessionsByAgentId.has(id)

      if (fromUrl && fromUrl !== 'new') {
        if (!sessionsLoaded || knownIds.has(fromUrl)) return fromUrl
        // Foreign ?session= from a previous agent — ignore.
      }

      const remembered = store.lastActiveSessionIdByAgentId[id]?.trim()
      if (remembered && (!sessionsLoaded || knownIds.has(remembered))) {
        return remembered
      }

      const local = cached.map((session) => ({
        friendlyId: session.sessionId,
      }))
      const resolved = resolveSessionForProfile(local, id, { sessionsLoaded })
      return resolved === 'new' ? null : resolved
    }

    const applyAgent = async () => {
      if (cancelled) return
      const store = useAgentStore.getState()
      const agent = store.agents.find((entry) => entry.agentId === agentId)

      // Unknown / stale URL agent id — bounce to a real registry entry instead of
      // painting "Select an agent to start chatting."
      if (!agent) {
        if (store.agents.length > 0) {
          const fallback = pickChatAgentId(store.agents, null)
          if (fallback && fallback !== agentId) {
            void navigate({
              to: '/chat/agent/$agentId',
              params: { agentId: fallback },
              search: {},
              replace: true,
            })
            return
          }
        }
        // Empty registry — do not pin an unknown activeAgentId.
        setActiveAgentId(null, { sessionId: null })
        setSeeded(true)
        return
      }

      if (
        agent.runtime !== 'hermes' &&
        !store.sessionsByAgentId.has(agentId)
      ) {
        try {
          const data = await fetchSessionsForAgent(agentId)
          if (cancelled) return
          useAgentStore.getState().setSessions(agentId, data.sessions)
        } catch {
          if (cancelled) return
          useAgentStore.getState().setSessions(agentId, [])
        }
      }
      const sessionId = await resolveSessionForAgent(agentId)
      if (cancelled) return
      setActiveAgentId(agentId, { sessionId })
      // Drop a foreign ?session= that does not belong to this agent.
      if (
        search.session &&
        sessionId !== search.session &&
        useAgentStore.getState().sessionsByAgentId.has(agentId) &&
        !sessionBelongsToAgent(agentId, search.session)
      ) {
        void navigate({
          search: sessionId ? { session: sessionId } : {},
          replace: true,
        })
      }
      setSeeded(true)
    }

    if (useAgentStore.getState().agents.length === 0) {
      // Cold entry only — never flip seeded off on agent↔agent switches.
      fetchAgents()
        .then((data) => {
          if (cancelled) return
          useAgentStore.getState().setAgents(data.agents)
          void applyAgent()
        })
        .catch(() => {
          if (cancelled) return
          // Failed fetch with empty store — show empty state, do not invent an agent.
          setActiveAgentId(null, { sessionId: null })
          setSeeded(true)
        })
    } else {
      void applyAgent()
    }

    return () => {
      cancelled = true
    }
    // Only re-run on agentId. Session-only URL changes use the effect below;
    // putting search.session here would restore "last session" and undo New Chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [agentId, queryClient, setActiveAgentId, navigate])

  // Apply session from the URL only when it belongs to the route agent.
  useEffect(() => {
    if (!search.session || !agentId) return
    const store = useAgentStore.getState()
    if (!store.sessionsByAgentId.has(agentId)) {
      // List not loaded yet — applyAgent owns the first paint.
      return
    }
    if (!sessionBelongsToAgent(agentId, search.session)) {
      void navigate({ search: {}, replace: true })
      return
    }
    if (store.activeAgentId === agentId) {
      setActiveSessionId(search.session)
    }
  }, [search.session, agentId, setActiveSessionId, navigate])

  // Keep the URL in sync with the active session — only for THIS route agent.
  useEffect(() => {
    return useAgentStore.subscribe((state, prev) => {
      // Never rewrite URL from a stale global session while another agent is active.
      if (state.activeAgentId !== agentId) return

      const currentSession = state.activeSessionId
      const agentChanged = state.activeAgentId !== prev.activeAgentId

      if (
        currentSession &&
        currentSession !== search.session &&
        (sessionBelongsToAgent(agentId, currentSession) ||
          !state.sessionsByAgentId.has(agentId))
      ) {
        void navigate({
          search: { session: currentSession },
          replace: true,
        })
        return
      }

      // Clear foreign or New-Chat URL when this agent has no active session.
      if (!currentSession && search.session) {
        const foreign =
          state.sessionsByAgentId.has(agentId) &&
          !sessionBelongsToAgent(agentId, search.session)
        if (foreign || !agentChanged) {
          void navigate({
            search: {},
            replace: true,
          })
        }
      }
    })
  }, [navigate, search.session, agentId])

  if (!seeded) {
    return <ChatRouteLoading />
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<ChatRouteLoading />}>
        <AgentWorkspace />
      </Suspense>
    </ErrorBoundary>
  )
}
