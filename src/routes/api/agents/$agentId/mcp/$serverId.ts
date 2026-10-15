import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { requireJsonContentType } from '../../../../../server/rate-limit'
import {
  materializeAgentMcp,
  removeAgentMcpServer,
  setAgentMcpEnabled,
} from '../../../../../server/platform-mcp'

export const Route = createFileRoute('/api/agents/$agentId/mcp/$serverId')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        const serverId =
          typeof params.serverId === 'string' ? params.serverId : ''
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        if (typeof body.enabled !== 'boolean') {
          return json({ error: 'enabled boolean is required' }, { status: 400 })
        }
        const binding = setAgentMcpEnabled(agentId, serverId, body.enabled)
        if (!binding) {
          return json({ error: 'Binding not found' }, { status: 404 })
        }
        const materialize = materializeAgentMcp(agentId)
        return json({ server: binding, materialize })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        const serverId =
          typeof params.serverId === 'string' ? params.serverId : ''
        const ok = removeAgentMcpServer(agentId, serverId)
        if (!ok) {
          return json({ error: 'Binding not found' }, { status: 404 })
        }
        const materialize = materializeAgentMcp(agentId)
        return json({ ok: true, materialize })
      },
    },
  },
})
