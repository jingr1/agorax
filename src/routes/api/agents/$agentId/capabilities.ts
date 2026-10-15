/**
 * GET /api/agents/:agentId/capabilities
 *
 * Hermes + managed unified capabilities (model, workspace, skills, MCP).
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { buildAgentCapabilities } from '../../../../server/agent-capabilities'

export const Route = createFileRoute('/api/agents/$agentId/capabilities')({
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
        try {
          return json(buildAgentCapabilities(agentId))
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to read agent capabilities'
          const status = message.startsWith('Unknown agent') ? 404 : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
