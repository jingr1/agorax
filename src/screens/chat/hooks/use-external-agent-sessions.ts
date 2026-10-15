'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  deleteManagedSession,
  fetchSessionsForAgent,
  renameManagedSession,
} from '@/lib/agent-api'
import { useAgentStore } from '@/stores/agent-store'
import { writeLastSession } from '../last-session'
import type { SessionController } from '../session-controller'
import type { SessionMeta } from '../types'
import type { AgentSession } from '@/lib/agent-types'

function toSessionMeta(sessions: Array<AgentSession>): Array<SessionMeta> {
  return sessions.map(
    (s): SessionMeta => ({
      key: s.sessionId,
      friendlyId: s.sessionId,
      title: s.title,
      updatedAt: new Date(s.lastMessageAt).getTime(),
      lastMessage: null,
    }),
  )
}

/**
 * Session controller for managed agents. List/rename/delete go through
 * `/api/agents/:id/sessions`, which reads/writes the daemon Host (end-state).
 */
export function useExternalAgentSessions(
  agentId: string | null,
): SessionController {
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const setActiveSessionId = useAgentStore((s) => s.setActiveSessionId)
  const sessionsByAgentId = useAgentStore((s) => s.sessionsByAgentId)
  const setSessions = useAgentStore((s) => s.setSessions)
  const upsertSession = useAgentStore((s) => s.upsertSession)
  const removeSession = useAgentStore((s) => s.removeSession)
  const setSessionsLoading = useAgentStore((s) => s.setSessionsLoading)
  const sessionsLoading = useAgentStore((s) =>
    agentId ? s.sessionsLoading.has(agentId) : false,
  )
  const sessionsError = useAgentStore((s) => s.agentsError)
  const loadGenerationRef = useRef(0)

  const storeSessions = agentId
    ? (sessionsByAgentId.get(agentId) ?? [])
    : []

  const sessions = useMemo(
    () => toSessionMeta(storeSessions),
    [storeSessions],
  )

  const reload = useCallback(() => {
    if (!agentId) return
    const generation = ++loadGenerationRef.current
    setSessionsLoading(agentId, true)
    void fetchSessionsForAgent(agentId)
      .then((data) => {
        if (generation !== loadGenerationRef.current) return
        setSessions(agentId, data.sessions)
      })
      .catch(() => {
        if (generation !== loadGenerationRef.current) return
        setSessions(agentId, [])
      })
      .finally(() => {
        if (generation !== loadGenerationRef.current) return
        setSessionsLoading(agentId, false)
      })
  }, [agentId, setSessions, setSessionsLoading])

  useEffect(() => {
    reload()
  }, [reload])

  const onNewChat = useCallback(() => {
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const onRetry = useCallback(() => {
    reload()
  }, [reload])

  const onActivateSession = useCallback(
    (session: SessionMeta) => {
      if (agentId) writeLastSession(session.friendlyId, agentId)
      setActiveSessionId(session.friendlyId)
    },
    [agentId, setActiveSessionId],
  )

  const onRename = useCallback(
    (session: SessionMeta, title: string) => {
      if (!agentId) return
      void renameManagedSession(agentId, session.friendlyId, title)
        .then((updated) => upsertSession(agentId, updated))
        .catch(() => undefined)
    },
    [agentId, upsertSession],
  )

  const onDelete = useCallback(
    (session: SessionMeta) => {
      if (!agentId) return
      void deleteManagedSession(agentId, session.friendlyId)
        .then(() => removeSession(agentId, session.friendlyId))
        .catch(() => undefined)
    },
    [agentId, removeSession],
  )

  const onActiveSessionDelete = useCallback(() => {
    setActiveSessionId(null)
  }, [setActiveSessionId])

  return {
    sessions,
    loading: sessionsLoading,
    fetching: false,
    error: sessionsError,
    activeFriendlyId: activeSessionId ?? 'new',
    onNewChat,
    onRetry,
    onActivateSession,
    onRename,
    onDelete,
    onActiveSessionDelete,
  }
}
