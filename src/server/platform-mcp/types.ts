export type PlatformMcpTransport = 'stdio' | 'http'

export type PlatformMcpServer = {
  id: string
  name: string
  transport: PlatformMcpTransport
  /** Full MCP config (command/url/env/headers/auth…). Secrets live here. */
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** Safe summary for list APIs — no secrets. */
export type PlatformMcpServerSummary = {
  id: string
  name: string
  transport: PlatformMcpTransport
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
  transport: PlatformMcpTransport
}

export type CreatePlatformMcpInput = {
  name: string
  transport?: PlatformMcpTransport
  config: Record<string, unknown>
  id?: string
}

export type UpdatePlatformMcpInput = {
  name?: string
  transport?: PlatformMcpTransport
  /** Full replace of config (write-only semantics). */
  config?: Record<string, unknown>
}
