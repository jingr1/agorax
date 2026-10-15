import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { truncateSession } from '../../../server/hermes-api'
import {
  ensureGatewayProbed,
  getCapabilities,
} from '../../../server/gateway-capabilities'
import { ensureChatGateway, enterChatGateway } from '../../../server/chat-gateway'

export const Route = createFileRoute('/api/sessions/$sessionKey/truncate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf

        const sessionKey = params.sessionKey?.trim()
        if (!sessionKey || sessionKey === 'new' || sessionKey === 'main') {
          return json(
            { ok: false, error: 'sessionKey required' },
            { status: 400 },
          )
        }

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const keepRaw = body.keepCount ?? body.keep_count
        const keepCount = Number(keepRaw)
        if (!Number.isInteger(keepCount) || keepCount < 0) {
          return json(
            { ok: false, error: 'keepCount must be a non-negative integer' },
            { status: 400 },
          )
        }

        try {
          const requestedProfile =
            typeof body.profileName === 'string' ? body.profileName.trim() : ''
          enterChatGateway(await ensureChatGateway(requestedProfile))
          await ensureGatewayProbed()
          if (!getCapabilities().sessionTruncate) {
            return json(
              {
                ok: false,
                error:
                  'Session truncate is not available on this Hermes build. Edit / Regenerate /undo /retry need upstream session_truncate support — do not patch local hermes.',
                code: 'session_truncate_unavailable',
              },
              { status: 501 },
            )
          }
          const result = await truncateSession(sessionKey, keepCount)
          return json({
            ok: true,
            keepCount: result.keep_count,
            removedCount: result.removed_count,
          })
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
