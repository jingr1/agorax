import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export type PlatformMcpSummary = {
  id: string
  name: string
  transport: 'stdio' | 'http'
  createdAt: number
  updatedAt: number
  boundAgentCount: number
}

export type AgentMcpBinding = {
  agentId: string
  serverId: string
  enabled: boolean
  createdAt: number
  name: string
  transport: 'stdio' | 'http'
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error || `Request failed (${res.status})`,
    )
  }
  return body
}

export function usePlatformMcpLibrary() {
  return useQuery({
    queryKey: ['platform-mcp'],
    queryFn: async (): Promise<Array<PlatformMcpSummary>> => {
      const res = await fetch('/api/platform-mcp')
      const body = await readJson<{ servers: Array<PlatformMcpSummary> }>(res)
      return body.servers ?? []
    },
    staleTime: 15_000,
  })
}

export function useAgentMcpBindings(agentId: string) {
  return useQuery({
    queryKey: ['agent-mcp', agentId],
    enabled: Boolean(agentId),
    queryFn: async (): Promise<Array<AgentMcpBinding>> => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/mcp`)
      const body = await readJson<{ servers: Array<AgentMcpBinding> }>(res)
      return body.servers ?? []
    },
    staleTime: 10_000,
  })
}

export function useCreatePlatformMcp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: unknown) => {
      const res = await fetch('/api/platform-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return readJson<{ server: PlatformMcpSummary }>(res)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform-mcp'] })
      void qc.invalidateQueries({ queryKey: ['mcp'] })
    },
  })
}

export function useDeletePlatformMcp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (serverId: string) => {
      const res = await fetch(
        `/api/platform-mcp/${encodeURIComponent(serverId)}`,
        { method: 'DELETE' },
      )
      return readJson<{ ok: boolean }>(res)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform-mcp'] })
      void qc.invalidateQueries({ queryKey: ['agent-mcp'] })
      void qc.invalidateQueries({ queryKey: ['mcp'] })
    },
  })
}

export function useAssignAgentMcp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      agentId: string
      serverIds: Array<string>
    }) => {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(input.agentId)}/mcp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverIds: input.serverIds }),
        },
      )
      return readJson<{ servers: Array<AgentMcpBinding> }>(res)
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['agent-mcp', vars.agentId] })
      void qc.invalidateQueries({ queryKey: ['platform-mcp'] })
      void qc.invalidateQueries({ queryKey: ['operations'] })
    },
  })
}

export function useSetAgentMcpEnabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      agentId: string
      serverId: string
      enabled: boolean
    }) => {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(input.agentId)}/mcp/${encodeURIComponent(input.serverId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: input.enabled }),
        },
      )
      return readJson<{ server: AgentMcpBinding }>(res)
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['agent-mcp', vars.agentId] })
      void qc.invalidateQueries({ queryKey: ['operations'] })
    },
  })
}

export function useRemoveAgentMcp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { agentId: string; serverId: string }) => {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(input.agentId)}/mcp/${encodeURIComponent(input.serverId)}`,
        { method: 'DELETE' },
      )
      return readJson<{ ok: boolean }>(res)
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['agent-mcp', vars.agentId] })
      void qc.invalidateQueries({ queryKey: ['platform-mcp'] })
      void qc.invalidateQueries({ queryKey: ['operations'] })
    },
  })
}
