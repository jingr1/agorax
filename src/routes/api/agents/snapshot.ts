import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { buildAgentsSnapshotPayload } from '../../../server/agents-status'

/**
 * GET /api/agents/snapshot — single aggregate for Agents/Missions status KPIs.
 * Includes agents/status payload plus a derived health summary so the UI can
 * poll one endpoint instead of status + crew + swarm-runtime + swarm-health.
 */
export const Route = createFileRoute('/api/agents/snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        return json(await buildAgentsSnapshotPayload())
      },
    },
  },
})
