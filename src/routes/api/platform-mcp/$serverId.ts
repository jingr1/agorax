import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  deletePlatformMcpServer,
  getPlatformMcpServer,
  listMcpServerAgentBindings,
  materializeAgentMcp,
  rematerializeAgentsForMcpServer,
  updatePlatformMcpServer,
  type PlatformMcpTransport,
} from '../../../server/platform-mcp'

function readTransport(value: unknown): PlatformMcpTransport | undefined {
  if (value === 'http' || value === 'stdio') return value
  return undefined
}

function toSummary(server: {
  id: string
  name: string
  transport: PlatformMcpTransport
  createdAt: number
  updatedAt: number
}) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }
}

export const Route = createFileRoute('/api/platform-mcp/$serverId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const serverId =
          typeof params.serverId === 'string' ? params.serverId : ''
        const server = getPlatformMcpServer(serverId)
        if (!server) {
          return json({ error: 'MCP server not found' }, { status: 404 })
        }
        const agents = listMcpServerAgentBindings(server.id)
        // Config is write-only — do not return secrets
        return json({
          server: {
            ...toSummary(server),
            boundAgentCount: agents.length,
          },
          agents,
        })
      },
      PUT: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const serverId =
          typeof params.serverId === 'string' ? params.serverId : ''
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        try {
          const server = updatePlatformMcpServer(serverId, {
            name: typeof body.name === 'string' ? body.name : undefined,
            transport: readTransport(body.transport),
            config:
              body.config &&
              typeof body.config === 'object' &&
              !Array.isArray(body.config)
                ? (body.config as Record<string, unknown>)
                : undefined,
          })
          rematerializeAgentsForMcpServer(server.id)
          return json({
            server: {
              ...toSummary(server),
              boundAgentCount: listMcpServerAgentBindings(server.id).length,
            },
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to update MCP server'
          const status = message.includes('not found')
            ? 404
            : message.includes('already exists')
              ? 409
              : 400
          return json({ error: message }, { status })
        }
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const serverId =
          typeof params.serverId === 'string' ? params.serverId : ''
        const agents = listMcpServerAgentBindings(serverId)
        const ok = deletePlatformMcpServer(serverId)
        if (!ok) {
          return json({ error: 'MCP server not found' }, { status: 404 })
        }
        for (const binding of agents) {
          materializeAgentMcp(binding.agentId)
        }
        return json({ ok: true })
      },
    },
  },
})
