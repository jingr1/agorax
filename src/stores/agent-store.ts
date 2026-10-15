'use client'

import { create } from 'zustand'
import type { AgentSession, AgentWithStatus } from '@/lib/agent-types'

interface AgentStore {
  agents: Array<AgentWithStatus>
  agentsLoading: boolean
  agentsError: string | null
  activeAgentId: string | null
  sessionsByAgentId: Map<string, Array<AgentSession>>
  sessionsLoading: Set<string>
  /** Currently selected session in the single chat pane (Agorax: activeConversationId). */
  activeSessionId: string | null
  /**
   * Per-agent last active session (Agorax: lastActiveAgentSessionIdByAgentTargetId).
   * Switching agents restores from this map instead of leaking a global session.
   */
  lastActiveSessionIdByAgentId: Record<string, string>

  setAgents: (agents: Array<AgentWithStatus>) => void
  setAgentsLoading: (loading: boolean) => void
  setAgentsError: (error: string | null) => void
  setActiveAgentId: (
    agentId: string | null,
    options?: { sessionId?: string | null },
  ) => void
  updateAgent: (agent: Partial<AgentWithStatus> & { agentId: string }) => void
  setSessions: (agentId: string, sessions: Array<AgentSession>) => void
  upsertSession: (agentId: string, session: AgentSession) => void
  removeSession: (agentId: string, sessionId: string) => void
  clearSessions: (agentId: string) => void
  setSessionsLoading: (agentId: string, loading: boolean) => void
  setActiveSessionId: (sessionId: string | null) => void
  /** Drop remembered sessions (e.g. after delete). */
  forgetSessionMemories: (sessionIds: ReadonlySet<string>) => void
}

function rememberSession(
  memories: Record<string, string>,
  agentId: string | null,
  sessionId: string | null,
): Record<string, string> {
  if (!agentId) return memories
  const trimmedAgent = agentId.trim()
  const trimmedSession = sessionId?.trim() ?? ''
  if (!trimmedAgent) return memories
  if (!trimmedSession || trimmedSession === 'new') {
    const next = { ...memories }
    delete next[trimmedAgent]
    return next
  }
  if (memories[trimmedAgent] === trimmedSession) return memories
  return { ...memories, [trimmedAgent]: trimmedSession }
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [],
  agentsLoading: false,
  agentsError: null,
  activeAgentId: null,
  sessionsByAgentId: new Map(),
  sessionsLoading: new Set(),
  activeSessionId: null,
  lastActiveSessionIdByAgentId: {},

  setAgents: (agents) => set({ agents }),
  setAgentsLoading: (agentsLoading) => set({ agentsLoading }),
  setAgentsError: (agentsError) => set({ agentsError }),
  setActiveAgentId: (activeAgentId, options) => {
    const state = get()
    if (activeAgentId === state.activeAgentId) {
      if (
        options &&
        'sessionId' in options &&
        options.sessionId !== state.activeSessionId
      ) {
        const sessionId = options.sessionId ?? null
        set({
          activeSessionId: sessionId,
          // Only remember non-null selections; New Chat keeps prior memory.
          ...(sessionId
            ? {
                lastActiveSessionIdByAgentId: rememberSession(
                  state.lastActiveSessionIdByAgentId,
                  activeAgentId,
                  sessionId,
                ),
              }
            : {}),
        })
      }
      return
    }

    // Agorax: write previous target's last, then restore (or clear) for the next.
    let memories = state.lastActiveSessionIdByAgentId
    if (state.activeAgentId && state.activeSessionId) {
      memories = rememberSession(
        memories,
        state.activeAgentId,
        state.activeSessionId,
      )
    }

    let nextSession: string | null
    if (options && 'sessionId' in options) {
      nextSession = options.sessionId ?? null
    } else if (activeAgentId) {
      nextSession = memories[activeAgentId] ?? null
    } else {
      nextSession = null
    }

    if (activeAgentId && nextSession) {
      memories = rememberSession(memories, activeAgentId, nextSession)
    }

    set({
      activeAgentId,
      activeSessionId: nextSession,
      lastActiveSessionIdByAgentId: memories,
    })
  },
  updateAgent: (update) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.agentId === update.agentId ? { ...agent, ...update } : agent,
      ),
    })),
  setSessions: (agentId, sessions) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      next.set(agentId, sessions)
      return { sessionsByAgentId: next }
    }),
  upsertSession: (agentId, session) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      const current = next.get(agentId) ?? []
      const without = current.filter((s) => s.sessionId !== session.sessionId)
      next.set(
        agentId,
        [session, ...without].sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime(),
        ),
      )
      return { sessionsByAgentId: next }
    }),
  removeSession: (agentId, sessionId) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      const current = next.get(agentId) ?? []
      next.set(
        agentId,
        current.filter((s) => s.sessionId !== sessionId),
      )
      const forgotten = new Set([sessionId])
      const memories = Object.fromEntries(
        Object.entries(state.lastActiveSessionIdByAgentId).filter(
          ([, id]) => !forgotten.has(id),
        ),
      )
      return {
        sessionsByAgentId: next,
        lastActiveSessionIdByAgentId: memories,
        activeSessionId:
          state.activeSessionId === sessionId ? null : state.activeSessionId,
      }
    }),
  clearSessions: (agentId) =>
    set((state) => {
      const next = new Map(state.sessionsByAgentId)
      next.delete(agentId)
      const memories = { ...state.lastActiveSessionIdByAgentId }
      delete memories[agentId]
      return {
        sessionsByAgentId: next,
        lastActiveSessionIdByAgentId: memories,
      }
    }),
  setSessionsLoading: (agentId, loading) =>
    set((state) => {
      const next = new Set(state.sessionsLoading)
      if (loading) next.add(agentId)
      else next.delete(agentId)
      return { sessionsLoading: next }
    }),
  setActiveSessionId: (activeSessionId) =>
    set((state) => {
      if (!activeSessionId) {
        // New Chat: clear the pane selection but keep per-agent memory so
        // switching away and back can restore (Agorax Home composer behavior).
        return { activeSessionId: null }
      }
      return {
        activeSessionId,
        lastActiveSessionIdByAgentId: rememberSession(
          state.lastActiveSessionIdByAgentId,
          state.activeAgentId,
          activeSessionId,
        ),
      }
    }),
  forgetSessionMemories: (sessionIds) =>
    set((state) => {
      if (sessionIds.size === 0) return state
      const memories = Object.fromEntries(
        Object.entries(state.lastActiveSessionIdByAgentId).filter(
          ([, id]) => !sessionIds.has(id),
        ),
      )
      return {
        lastActiveSessionIdByAgentId: memories,
        activeSessionId:
          state.activeSessionId && sessionIds.has(state.activeSessionId)
            ? null
            : state.activeSessionId,
      }
    }),
}))

export function getActiveAgent(): AgentWithStatus | undefined {
  const state = useAgentStore.getState()
  return state.agents.find((a) => a.agentId === state.activeAgentId)
}

export function getActiveSessions(): Array<AgentSession> {
  const state = useAgentStore.getState()
  if (!state.activeAgentId) return []
  return state.sessionsByAgentId.get(state.activeAgentId) ?? []
}

/** Whether a session id is known to belong to the given agent. */
export function sessionBelongsToAgent(
  agentId: string,
  sessionId: string | null | undefined,
): boolean {
  const trimmed = sessionId?.trim()
  if (!trimmed || trimmed === 'new') return false
  const sessions = useAgentStore.getState().sessionsByAgentId.get(agentId)
  if (!sessions) return false
  return sessions.some((session) => session.sessionId === trimmed)
}
