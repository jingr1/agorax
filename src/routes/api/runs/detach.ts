import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { markRunStatus } from '../../../server/run-store'
import { markRunDetached } from '../../../server/stream-handoff-registry'

type DetachBody = {
  runId?: string
  sessionKey?: string
  profileName?: string
}

export const Route = createFileRoute('/api/runs/detach')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        let body: DetachBody
        try {
          body = (await request.json()) as DetachBody
        } catch {
          return json(
            { ok: false, error: 'Invalid JSON body' },
            { status: 400 },
          )
        }

        const runId = (body.runId ?? '').trim()
        const sessionKey = (body.sessionKey ?? '').trim()
        if (!runId || !sessionKey) {
          return json(
            { ok: false, error: 'runId and sessionKey required' },
            { status: 400 },
          )
        }

        markRunDetached(runId)
        try {
          await markRunStatus(sessionKey, runId, 'handoff')
        } catch {
          // Detach registry is authoritative; run file may not exist yet.
        }

        return json({
          ok: true,
          runId,
          sessionKey,
          profileName: (body.profileName ?? '').trim() || null,
        })
      },
    },
  },
})
