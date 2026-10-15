import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  formatSwarmWorkerRestartSummary,
  listActiveSwarmWorkerIds,
  restartActiveSwarmWorkers,
} from '../../server/swarm-tmux-restart'

type RestartRequest = {
  workerIds?: unknown
}

function cleanWorkerIds(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(item))
  return ids.length ? [...new Set(ids)] : undefined
}

export const Route = createFileRoute('/api/swarm-tmux-restart-active')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: RestartRequest = {}
        try {
          if (request.headers.get('content-length')) {
            body = (await request.json()) as RestartRequest
          }
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const workerIds = cleanWorkerIds(body.workerIds)
        const activeBefore = await listActiveSwarmWorkerIds()
        const result = await restartActiveSwarmWorkers({ workerIds })

        return json({
          ok: true,
          activeBefore,
          ...result,
          summary: formatSwarmWorkerRestartSummary(result),
        })
      },
    },
  },
})
