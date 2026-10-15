'use client'

import { useNavigate } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import { Settings01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons'
import { AgentStatusDot } from './agent-status-dot'
import type { AgentWithStatus } from '@/lib/agent-types'
import { Button } from '@/components/ui/button'

export function ManagedRuntimePanel({
  agent,
  sessionId,
}: {
  agent: AgentWithStatus
  sessionId: string | null
}) {
  const navigate = useNavigate()
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary-100 dark:bg-primary-800">
        <HugeiconsIcon
          icon={SourceCodeIcon}
          size={32}
          className="text-primary-500 dark:text-primary-400"
        />
      </div>
      <h2 className="mb-1 text-lg font-semibold text-primary-950 dark:text-primary-100">
        {agent.name}
      </h2>
      <div className="mb-4 flex items-center gap-2 text-sm text-primary-600 dark:text-primary-400">
        <AgentStatusDot status={agent.status} />
        <span className="capitalize">{agent.runtime.replace(/-/g, ' ')}</span>
        {sessionId ? <span>· session {sessionId.slice(0, 8)}</span> : null}
      </div>
      <p className="mb-6 max-w-sm text-sm text-primary-500 dark:text-primary-400">
        The {agent.runtime} workspace is under construction. Configure the
        runtime below to connect this agent.
      </p>
      <Button
        onClick={() =>
          void navigate({
            to: '/agents',
            search: { agent: agent.agentId },
          })
        }
      >
        <HugeiconsIcon icon={Settings01Icon} size={16} strokeWidth={1.5} />
        Configure {agent.name}
      </Button>
    </div>
  )
}
