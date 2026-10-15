import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { listJobDeliveryTargets } from '../../server/job-delivery-targets'

export const Route = createFileRoute('/api/job-delivery-targets')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }

        const targets = listJobDeliveryTargets()

        return new Response(JSON.stringify({ targets }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
