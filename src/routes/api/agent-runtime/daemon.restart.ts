import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { restartManagedAgentDaemon } from '../../../server/agent-runtime/managed-agent-daemon'

/**
 * POST /api/agent-runtime/daemon/restart — force-restart the local Agorax
 * managed-agent daemon (`:8788`) and wait until `/health` responds.
 */
export const Route = createFileRoute('/api/agent-runtime/daemon/restart')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const result = await restartManagedAgentDaemon()
          if (!result.ok || !result.healthy) {
            return json(
              {
                error: result.detail || 'Managed Agent daemon restart failed',
                detail: result.detail,
              },
              { status: 503 },
            )
          }
          return json({
            ok: true,
            healthy: true,
            detail: result.detail,
          })
        } catch (error) {
          return json(
            {
              error: `Managed Agent daemon restart failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            { status: 502 },
          )
        }
      },
    },
  },
})
