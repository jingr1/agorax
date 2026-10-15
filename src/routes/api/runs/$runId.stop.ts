import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { stopRun as stopHermesRun } from '../../../server/hermes-api'
import {
  getActiveSendRunHandle,
  interruptActiveSendRun,
  interruptActiveSendRunsForSession,
} from '../../../server/send-run-tracker'
import { markRunStatus } from '../../../server/run-store'
import { clearRunDetached } from '../../../server/stream-handoff-registry'

/**
 * POST /api/runs/:runId/stop
 *
 * Hard-stop a live Workspace → Hermes send-stream turn. Unlike abandoning a
 * persisted run row, this aborts the in-process upstream AbortController so
 * Hermes sees SSE disconnect / interrupt even when the browser lost its
 * fetch handle (handoff, remount, stale Thinking UI).
 */
export const Route = createFileRoute('/api/runs/$runId/stop')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf

        const runId = params.runId?.trim()
        if (!runId) {
          return json({ ok: false, error: 'runId required' }, { status: 400 })
        }

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const sessionKeyRaw = body.sessionKey ?? body.session_id
        const sessionKey =
          typeof sessionKeyRaw === 'string' ? sessionKeyRaw.trim() : ''

        clearRunDetached(runId)

        const liveHandle = getActiveSendRunHandle(runId)
        const resolvedSessionKey = sessionKey || liveHandle?.sessionKey || ''

        const interruptedRunIds = new Set<string>()
        if (interruptActiveSendRun(runId)) {
          interruptedRunIds.add(runId)
        }
        // Concurrent overlapping turns on the same session are common after
        // failed Stops; wipe every live handle for the session.
        if (resolvedSessionKey) {
          for (const id of interruptActiveSendRunsForSession(
            resolvedSessionKey,
          )) {
            interruptedRunIds.add(id)
            clearRunDetached(id)
          }
        }

        // Best-effort: if this id is also a durable Hermes /v1/runs id, stop it.
        let hermesStopped = false
        if (!runId.startsWith('session:')) {
          try {
            await stopHermesRun(runId)
            hermesStopped = true
          } catch {
            // Chat completions turns use workspace run ids — gateway may 404.
          }
        }

        const statusTargets = new Set<string>(interruptedRunIds)
        statusTargets.add(runId)
        if (resolvedSessionKey) {
          await Promise.all(
            [...statusTargets].map((id) =>
              markRunStatus(
                resolvedSessionKey,
                id,
                'error',
                'Stopped by user',
              ).catch(() => null),
            ),
          )
        }

        return json({
          ok: true,
          runId,
          sessionKey: resolvedSessionKey || null,
          interrupted: interruptedRunIds.size > 0 || hermesStopped,
          interruptedRunIds: [...interruptedRunIds],
          hermesStopped,
        })
      },
    },
  },
})
