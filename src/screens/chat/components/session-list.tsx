'use client'

import { useMemo } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Add01Icon } from '@hugeicons/core-free-icons'
import type { AgentSession, AgentSessionState } from '@/lib/agent-types'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agent-store'
import { createSessionForAgent } from '@/lib/agent-api'

const STATE_LABELS: Record<AgentSessionState, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Done',
  error: 'Error',
  paused: 'Paused',
}

function SessionListItem({
  session,
  isActive,
  onSelect,
}: {
  session: AgentSession
  isActive: boolean
  onSelect: (sessionId: string) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.sessionId)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(session.sessionId)
        }
      }}
      className={cn(
        'flex flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors cursor-pointer outline-none',
        'hover:bg-primary-200/60 dark:hover:bg-primary-800/60',
        isActive && 'bg-primary-200 dark:bg-primary-800',
      )}
    >
      <p className="truncate text-sm font-medium text-primary-950 dark:text-primary-100">
        {session.title}
      </p>
      <div className="flex items-center gap-2 text-xs text-primary-500 dark:text-primary-400">
        <span>{STATE_LABELS[session.state]}</span>
        <span className="text-primary-300 dark:text-primary-600">·</span>
        <span>{new Date(session.lastMessageAt).toLocaleDateString()}</span>
      </div>
    </div>
  )
}

export function SessionList() {
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const sessionsByAgentId = useAgentStore((state) => state.sessionsByAgentId)
  const sessionsLoading = useAgentStore((state) => state.sessionsLoading)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const setActiveSessionId = useAgentStore((state) => state.setActiveSessionId)
  const setSessions = useAgentStore((state) => state.setSessions)

  const sessions = useMemo(() => {
    if (!activeAgentId) return []
    return sessionsByAgentId.get(activeAgentId) ?? []
  }, [activeAgentId, sessionsByAgentId])

  const loading = activeAgentId ? sessionsLoading.has(activeAgentId) : false

  const handleNewSession = async () => {
    if (!activeAgentId) return
    const created = await createSessionForAgent(activeAgentId)
    const placeholder: AgentSession = {
      sessionId: created.sessionId,
      agentId: activeAgentId,
      title: 'New session',
      state: 'idle',
      lastMessageAt: new Date().toISOString(),
    }
    setSessions(activeAgentId, [placeholder, ...sessions])
    setActiveSessionId(created.sessionId)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-primary-200 dark:border-primary-800">
      <div className="flex items-center justify-between border-b border-primary-200 px-3 py-2 dark:border-primary-800">
        <span className="text-xs font-semibold uppercase tracking-wide text-primary-500 dark:text-primary-400">
          Sessions
        </span>
        <button
          type="button"
          onClick={handleNewSession}
          disabled={!activeAgentId}
          className={cn(
            'rounded-md p-1 text-primary-500 transition-colors',
            'hover:bg-primary-200/60 hover:text-primary-700',
            'disabled:pointer-events-none disabled:opacity-40',
            'dark:text-primary-400 dark:hover:bg-primary-800 dark:hover:text-primary-200',
          )}
          title="New session"
        >
          <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <p className="px-3 py-4 text-sm text-primary-500 dark:text-primary-400">
            Loading sessions…
          </p>
        ) : sessions.length === 0 ? (
          <p className="px-3 py-4 text-sm text-primary-500 dark:text-primary-400">
            No sessions yet.
          </p>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((session) => (
              <SessionListItem
                key={session.sessionId}
                session={session}
                isActive={session.sessionId === activeSessionId}
                onSelect={setActiveSessionId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
