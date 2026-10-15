'use client'

import { useEffect, useMemo } from 'react'
import { AgentIdentityAvatar } from '@/components/avatars'
import {
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { fetchAgents } from '@/lib/agent-api'
import type { AgentWithStatus } from '@/lib/agent-types'
import {
  countAgentsByProvider,
  normalizeAgentAvatarProvider,
} from '@/lib/agent-avatar'
import { useAgentStore } from '@/stores/agent-store'
import { getInitials } from '../lib/avatar-utils'

type MemberAvatarProps = {
  id: string
  name: string
  kind: 'human' | 'agent' | 'system'
  status?: 'idle' | 'thinking' | 'running' | 'complete' | 'failed'
  size?: number
  className?: string
  /**
   * Fallback only — preferred source is GET /api/agents via agent store
   * (same path chat uses for AgentIdentityAvatar).
   */
  runtime?: string
  /** Fallback sibling count when the agent registry is not loaded yet. */
  providerSiblingCount?: number
  /** When false, skip the built-in tooltip (parent already provides one). */
  showTooltip?: boolean
}

/** Dedupe concurrent MemberAvatar mounts before the registry is warm. */
let agentsLoadPromise: Promise<void> | null = null

function ensureAgentRegistryLoaded(
  agentsLength: number,
  setAgents: (agents: Array<AgentWithStatus>) => void,
) {
  if (agentsLength > 0 || agentsLoadPromise) return
  agentsLoadPromise = fetchAgents()
    .then((data) => {
      setAgents(data.agents)
    })
    .catch(() => {
      /* keep prop fallbacks */
    })
    .finally(() => {
      agentsLoadPromise = null
    })
}

function AvatarFace({
  name,
  kind,
  size,
  runtime,
  providerSiblingCount,
}: {
  name: string
  kind: 'human' | 'agent' | 'system'
  size: number
  runtime?: string
  providerSiblingCount?: number
}) {
  if (kind === 'human') {
    return (
      <div
        className="flex items-center justify-center rounded-full border-2 border-white/10 font-semibold"
        style={{
          width: size,
          height: size,
          background: '#1A2340',
          color: '#E6EAF2',
          fontSize: Math.max(10, size * 0.4),
        }}
      >
        {getInitials(name)}
      </div>
    )
  }

  return (
    <AgentIdentityAvatar
      name={name}
      runtime={runtime ?? 'hermes'}
      providerSiblingCount={providerSiblingCount ?? 1}
      size={size}
    />
  )
}

export function MemberAvatar({
  id,
  name,
  kind,
  size = 32,
  className,
  runtime,
  providerSiblingCount,
  showTooltip = true,
}: MemberAvatarProps) {
  const agents = useAgentStore((state) => state.agents)
  const setAgents = useAgentStore((state) => state.setAgents)

  useEffect(() => {
    if (kind !== 'agent') return
    ensureAgentRegistryLoaded(agents.length, setAgents)
  }, [kind, agents.length, setAgents])

  // Same identity path as chat AgentList: GET /api/agents runtime + sibling count.
  const registryAgent =
    kind === 'agent' ? agents.find((a) => a.agentId === id) : undefined
  const resolvedRuntime = registryAgent?.runtime ?? runtime ?? 'hermes'
  const siblingCounts = useMemo(
    () => (agents.length > 0 ? countAgentsByProvider(agents) : null),
    [agents],
  )
  const resolvedSiblingCount =
    siblingCounts?.get(normalizeAgentAvatarProvider(resolvedRuntime)) ??
    providerSiblingCount ??
    1

  const face = (
    <AvatarFace
      name={name}
      kind={kind}
      size={size}
      runtime={resolvedRuntime}
      providerSiblingCount={resolvedSiblingCount}
    />
  )

  if (!showTooltip) {
    return <div className={className}>{face}</div>
  }

  const label = kind === 'human' ? `${name} (you)` : name

  return (
    <TooltipProvider>
      <TooltipRoot>
        <TooltipTrigger type="button" className={className}>
          {face}
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  )
}
