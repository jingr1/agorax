import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { buildAgentsStatusPayload } from '../../../server/agents-status'

/**
 * GET /api/agents/status — declared agents + probe + unified live status.
 */
export const Route = createFileRoute('/api/agents/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        return json(await buildAgentsStatusPayload())
      },
    },
  },
})
