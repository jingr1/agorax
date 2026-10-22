import { useQuery } from '@tanstack/react-query'
import type { McpListResponse } from '@/types/mcp'

export interface UseMcpServersParams {
  tab: 'installed' | 'catalog' | 'all'
  category: string
  search: string
  /** Hermes agent/profile id for per-profile mcp_servers. */
  profile?: string
  /** Skip fetch when Agents tab is not showing a Hermes profile. */
  enabled?: boolean
}

export function useMcpServers(params: UseMcpServersParams) {
  const { enabled = true, ...queryParams } = params
  return useQuery({
    queryKey: ['mcp', 'servers', queryParams],
    enabled: enabled && Boolean(queryParams.profile?.trim()),
    queryFn: async (): Promise<McpListResponse> => {
      const url = new URL('/api/mcp', window.location.origin)
      if (queryParams.search) url.searchParams.set('search', queryParams.search)
      if (queryParams.category && queryParams.category !== 'All') {
        url.searchParams.set('category', queryParams.category)
      }
      if (queryParams.profile?.trim()) {
        url.searchParams.set('profile', queryParams.profile.trim())
      }
      const res = await fetch(
        url.toString().replace(window.location.origin, ''),
      )
      if (!res.ok) throw new Error(`MCP list failed (${res.status})`)
      const body = (await res.json()) as Partial<McpListResponse> & {
        ok?: boolean
        code?: string
      }
      return {
        servers: body.servers ?? [],
        total: body.total ?? 0,
        categories: body.categories ?? ['All'],
      }
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}
