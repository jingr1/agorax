import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { markRunStatus } from '../../../server/run-store'
import { interruptActiveSendRun } from '../../../server/send-run-tracker'
import { clearRunDetached } from '../../../server/stream-handoff-registry'

export const Route = createFileRoute('/api/runs/$sessionKey/$runId/abandon')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const sessionKey = params.sessionKey?.trim()
        const runId = params.runId?.trim()
        if (!sessionKey || !runId) {
          return json(
            { ok: false, error: 'sessionKey and runId required' },
            { status: 400 },
          )
        }

        try {
          clearRunDetached(runId)
          interruptActiveSendRun(runId)
          const run = await markRunStatus(
            sessionKey,
            runId,
            'error',
            'Abandoned by user',
          )
          if (!run) {
            return json({ ok: false, error: 'run not found' }, { status: 404 })
          }
          return json({ ok: true, run })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
