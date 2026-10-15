import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { requireJsonContentType } from '../../../../server/rate-limit'
import {
  addAgentMcpServers,
  listAgentMcpBindings,
  materializeAgentMcp,
} from '../../../../server/platform-mcp'
import { getAgentRuntimeRouter } from '../../../../server/agent-runtime/router'

function agentExists(agentId: string): boolean {
  const router = getAgentRuntimeRouter()
  return (
    router.registry.byId.has(agentId) ||
    router.registry.orphanProfiles.includes(agentId)
  )
}

function parseServerIds(body: Record<string, unknown>): Array<string> {
  if (Array.isArray(body.serverIds)) {
    return body.serverIds
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean)
  }
  if (typeof body.serverId === 'string' && body.serverId.trim()) {
    return [body.serverId.trim()]
  }
  if (typeof body.server_id === 'string' && body.server_id.trim()) {
    return [body.server_id.trim()]
  }
  return []
}

export const Route = createFileRoute('/api/agents/$agentId/mcp')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        return json({
          agentId,
          servers: listAgentMcpBindings(agentId),
        })
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        if (!agentExists(agentId)) {
          return json({ error: `Unknown agent: ${agentId}` }, { status: 404 })
        }
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const ids = parseServerIds(body)
        if (ids.length === 0) {
          return json(
            { error: 'serverId or serverIds is required' },
            { status: 400 },
          )
        }
        try {
          const servers = addAgentMcpServers(agentId, ids)
          const materialize = materializeAgentMcp(agentId)
          return json({ agentId, servers, materialize })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to assign MCP'
          return json(
            { error: message },
            { status: message.includes('not found') ? 404 : 400 },
          )
        }
      },
    },
  },
})
