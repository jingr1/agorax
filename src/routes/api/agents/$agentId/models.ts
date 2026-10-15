/**
 * GET /api/agents/:agentId/models
 *
 * Per-agent model catalog .
 * Hermes → profile config; managed → Claude/Codex settings or daemon.
 * Never falls back to the global ~/.hermes /api/models catalog.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { buildAgentModels } from '../../../../server/agent-models'

export const Route = createFileRoute('/api/agents/$agentId/models')({
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
          const payload = await buildAgentModels(agentId)
          return json(payload)
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to read agent models'
          const status = message.startsWith('Unknown agent') ? 404 : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
