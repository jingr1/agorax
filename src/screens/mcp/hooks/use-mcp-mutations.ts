import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  McpClientInput,
  McpDiscoveredTool,
  McpServer,
  McpTestResult,
  McpToolMode,
} from '@/types/mcp'

function withProfile(path: string, profile?: string): string {
  if (!profile?.trim()) return path
  const url = new URL(path, window.location.origin)
  url.searchParams.set('profile', profile.trim())
  return `${url.pathname}${url.search}`
}

async function postJson<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' | 'DELETE' = 'POST',
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (method !== 'DELETE') init.body = JSON.stringify(body)
  const res = await fetch(path, init)
  const json = (await res.json().catch(() => ({}))) as T & {
    ok?: boolean
    error?: string
  }
  if (!res.ok || (json as { ok?: boolean }).ok === false) {
    throw new Error(json.error || `Request failed (${res.status})`)
  }
  return json
}

export function useTestMcpServer(profile?: string) {
  return useMutation<
    McpTestResult,
    Error,
    ({ name: string } | McpClientInput) & { profile?: string }
  >({
    mutationFn: (payload) => {
      const pin = payload.profile || profile
      return postJson<McpTestResult>(withProfile('/api/mcp/test', pin), {
        ...payload,
        ...(pin ? { profile: pin } : {}),
      })
    },
  })
}

export function useDiscoverMcpTools(profile?: string) {
  return useMutation<
    { ok: boolean; tools: Array<McpDiscoveredTool> },
    Error,
    McpClientInput & { profile?: string }
  >({
    mutationFn: (payload) => {
      const pin = payload.profile || profile
      return postJson<{ ok: boolean; tools: Array<McpDiscoveredTool> }>(
        withProfile('/api/mcp/discover', pin),
        { ...payload, ...(pin ? { profile: pin } : {}) },
      )
    },
  })
}

export function useUpsertMcpServer(profile?: string) {
  const qc = useQueryClient()
  // Inline `& { bearerToken? }` keeps the secret-bearing shape unexported —
  // no client module re-exports a type containing `bearerToken` or
  // `oauth.clientSecret`. Server-side `parseMcpServerInput` re-validates and
  // strips before persistence.
  return useMutation<
    { ok: boolean; server: McpServer },
    Error,
    McpClientInput & { bearerToken?: string; profile?: string }
  >({
    mutationFn: (payload) => {
      const pin = payload.profile || profile
      return postJson<{ ok: boolean; server: McpServer }>(
        withProfile('/api/mcp', pin),
        { ...payload, ...(pin ? { profile: pin } : {}) },
      )
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
  })
}

export interface ConfigureInput {
  name: string
  enabled?: boolean
  toolMode?: McpToolMode
  includeTools?: Array<string>
  excludeTools?: Array<string>
  profile?: string
}

export function useConfigureMcpServer(profile?: string) {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean; server: McpServer }, Error, ConfigureInput>(
    {
      mutationFn: (payload) => {
        const pin = payload.profile || profile
        return postJson<{ ok: boolean; server: McpServer }>(
          withProfile('/api/mcp/configure', pin),
          { ...payload, ...(pin ? { profile: pin } : {}) },
          'PUT',
        )
      },
      onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
    },
  )
}

export function useDeleteMcpServer(profile?: string) {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean }, Error, { name: string; profile?: string }>(
    {
      mutationFn: ({ name, profile: payloadProfile }) =>
        postJson<{ ok: boolean }>(
          withProfile(
            `/api/mcp/${encodeURIComponent(name)}`,
            payloadProfile || profile,
          ),
          null,
          'DELETE',
        ),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
    },
  )
}
