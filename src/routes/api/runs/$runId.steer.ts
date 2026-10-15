import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { steerRun } from '../../../server/hermes-api'
import { ensureChatGateway, enterChatGateway } from '../../../server/chat-gateway'

export const Route = createFileRoute('/api/runs/$runId/steer')({
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
        const textRaw = body.text ?? body.input ?? body.message
        const text = typeof textRaw === 'string' ? textRaw.trim() : ''
        if (!text) {
          return json({ ok: false, error: 'text required' }, { status: 400 })
        }

        try {
          const requestedProfile =
            typeof body.profileName === 'string' ? body.profileName.trim() : ''
          enterChatGateway(await ensureChatGateway(requestedProfile))
          const result = await steerRun(runId, text)
          return json({
            ok: true,
            accepted: result.accepted !== false,
            runId: result.run_id ?? runId,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const isConflict =
            message.includes('409') ||
            message.includes('run_not_accepting_steer') ||
            message.includes('steer_not_accepted')
          return json(
            {
              ok: false,
              error: message,
              fallback: isConflict ? 'queue' : undefined,
            },
            { status: isConflict ? 409 : 500 },
          )
        }
      },
    },
  },
})
