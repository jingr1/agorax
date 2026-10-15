import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../../../../../server/agent-runtime/router'

/**
 * POST /api/agents/:agentId/runs/:runId/interrupt
 *
 * Explicit Stop — SIGKILL the managed run. Distinct from SSE client detach
 * (session switch), which must not kill the process.
 */
export const Route = createFileRoute(
  '/api/agents/$agentId/runs/$runId/interrupt',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const agentId =
          typeof params.agentId === 'string' ? params.agentId.trim() : ''
        const runId =
          typeof params.runId === 'string' ? params.runId.trim() : ''
        if (!agentId || !runId) {
          return json(
            { ok: false, error: 'agentId and runId are required' },
            { status: 400 },
          )
        }

        const router = getAgentRuntimeRouter()
        const adapter = router.getAdapter(agentId)
        if (!adapter) {
          return json(
            { ok: false, error: `unknown agent: ${agentId}` },
            { status: 404 },
          )
        }

        try {
          await adapter.interrupt(runId, 'user abort')
          return json({ ok: true, runId, interrupted: true })
        } catch (error) {
          return json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
