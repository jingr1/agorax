import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentStatusEntry } from '@/lib/mission-control-api'
import type { UnifiedAgentStatus } from '@/lib/agent-status'

export type AgentsHealthSummary = {
  online: number
  active: number
  blocked: number
  needsHuman: number
  offline: number
  needsSetup: number
  working: number
  unstable: number
  degraded: boolean
}

export type AgentsSnapshot = {
  agents: Array<AgentStatusEntry>
  orphanProfiles: Array<string>
  checkedAt: number
  health: AgentsHealthSummary
}

export const AGENTS_SNAPSHOT_QUERY_KEY = ['agents', 'snapshot'] as const

const POLL_INTERVAL_MS = 30_000

export async function fetchAgentsSnapshot(): Promise<AgentsSnapshot> {
  const res = await fetch('/api/agents/snapshot')
  if (!res.ok) throw new Error(`Failed to fetch agents snapshot: ${res.status}`)
  return res.json() as Promise<AgentsSnapshot>
}

export function mapUnifiedToOperationsStatus(
  unified: UnifiedAgentStatus | undefined,
  needsSetup: boolean,
):
  | 'active'
  | 'idle'
  | 'offline'
  | 'blocked'
  | 'error'
  | 'needsSetup' {
  if (needsSetup || unified === 'needsSetup') return 'needsSetup'
  switch (unified) {
    case 'active':
      return 'active'
    case 'idle':
      return 'idle'
    case 'blocked':
      return 'blocked'
    case 'error':
      return 'error'
    case 'offline':
      return 'offline'
    default:
      return 'offline'
  }
}

export function useAgentSnapshot(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient()
  const enabled = options?.enabled ?? true

  const query = useQuery({
    queryKey: AGENTS_SNAPSHOT_QUERY_KEY,
    queryFn: fetchAgentsSnapshot,
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: 20_000,
  })

  useEffect(() => {
    if (!enabled) return
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({
          queryKey: AGENTS_SNAPSHOT_QUERY_KEY,
        })
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () =>
      document.removeEventListener('visibilitychange', handleVisibility)
  }, [enabled, queryClient])

  const byId = new Map(
    (query.data?.agents ?? []).map((entry) => [entry.agentId, entry]),
  )

  return {
    snapshot: query.data ?? null,
    agents: query.data?.agents ?? [],
    health: query.data?.health ?? null,
    byId,
    checkedAt: query.data?.checkedAt ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    query,
  }
}
