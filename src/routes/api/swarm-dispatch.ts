import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  dispatchSwarmAssignments,
  SwarmDispatchError,
} from '../../server/swarm-dispatch-service'
import type { DispatchRequest } from '../../server/swarm-dispatch-service'

export * from '../../server/swarm-dispatch-service'

export const Route = createFileRoute('/api/swarm-dispatch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        let body: DispatchRequest
        try {
          body = await request.json() as DispatchRequest
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        try {
          return json(await dispatchSwarmAssignments(body))
        } catch (error) {
          if (error instanceof SwarmDispatchError) {
            return json({ error: error.message }, { status: error.status })
          }
          return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
