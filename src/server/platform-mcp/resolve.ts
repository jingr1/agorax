/**
 * Resolve enabled platform MCP bindings into a name→config map for any agent
 * (Hermes or managed). Used by materialize (Hermes FS) and managed startRun inject.
 */
import { getPlatformMcpServer, listAgentMcpBindings } from './store'
import { AGORAX_PLATFORM_MCP_MARKER } from '../mcp-profile-config'

export type ResolvedPlatformMcpEntry = {
  name: string
  serverId: string
  transport: 'stdio' | 'http'
  /** Hermes/Claude-compatible config object (may include secrets). */
  config: Record<string, unknown>
}

export function resolveEnabledPlatformMcpEntries(
  agentId: string,
): Array<ResolvedPlatformMcpEntry> {
  const out: Array<ResolvedPlatformMcpEntry> = []
  for (const binding of listAgentMcpBindings(agentId)) {
    if (!binding.enabled) continue
    const server = getPlatformMcpServer(binding.serverId)
    if (!server) continue
    const config: Record<string, unknown> = {
      ...server.config,
      transport: server.config.transport ?? server.transport,
      [AGORAX_PLATFORM_MCP_MARKER]: true,
      enabled: true,
    }
    out.push({
      name: server.name,
      serverId: server.id,
      transport: server.transport,
      config,
    })
  }
  return out
}

/**
 * Shape Claude Code / generic JSON mcpServers expect from a Hermes-style entry.
 */
export function toClaudeMcpServerEntry(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const transport = String(config.transport || '').toLowerCase()
  const entry: Record<string, unknown> = {}
  if (transport === 'http' || config.url) {
    if (typeof config.url === 'string') entry.url = config.url
    if (config.headers && typeof config.headers === 'object') {
      entry.headers = config.headers
    }
    const auth = config.auth
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      const a = auth as Record<string, unknown>
      if (typeof a.token === 'string' && a.token) {
        entry.headers = {
          ...((entry.headers as Record<string, string>) || {}),
          Authorization: `Bearer ${a.token}`,
        }
      }
    }
  } else {
    if (typeof config.command === 'string') entry.command = config.command
    if (Array.isArray(config.args)) entry.args = config.args
    if (config.env && typeof config.env === 'object') entry.env = config.env
  }
  return entry
}
