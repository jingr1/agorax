/**
 * POST /api/sessions/:sessionKey/model
 *
 * Lock the Hermes session to the composer-selected model for this chat.
 * Proxies to gateway `POST /api/sessions/{id}/model` with split
 * `model` + `provider` so the pick survives sticky session overrides and
 * matches what `/api/send-stream` forwards on each turn.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { hermesChatModelFields } from '../../../lib/chat-model-ref'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  ensureChatGateway,
  enterChatGateway,
} from '../../../server/chat-gateway'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  ensureGatewayProbed,
  getGatewayCapabilities,
  setSessionModel,
} from '../../../server/hermes-api'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/sessions/$sessionKey/model')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const sessionKey = params.sessionKey?.trim() || ''
        if (!sessionKey || sessionKey === 'new') {
          return json(
            { ok: false, error: 'sessionKey required' },
            { status: 400 },
          )
        }

        let body: Record<string, unknown> = {}
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }

        const profileName =
          typeof body.profileName === 'string' ? body.profileName.trim() : ''
        try {
          enterChatGateway(await ensureChatGateway(profileName || undefined))
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : 'gateway unavailable'
          return json({ ok: false, error: errorMsg }, { status: 503 })
        }

        await ensureGatewayProbed()
        if (!getGatewayCapabilities().sessions) {
          return json(
            { ok: false, error: SESSIONS_API_UNAVAILABLE_MESSAGE },
            { status: 503 },
          )
        }

        const rawModel =
          typeof body.model === 'string'
            ? body.model
            : typeof body.modelId === 'string'
              ? body.modelId
              : ''
        const explicitProvider =
          typeof body.provider === 'string' ? body.provider.trim() : ''
        const fields = hermesChatModelFields(rawModel)
        const model = fields.model?.trim() || ''
        const provider = explicitProvider || fields.provider
        if (!model) {
          return json({ ok: false, error: 'model required' }, { status: 400 })
        }

        try {
          const result = await setSessionModel(sessionKey, { model, provider })
          return json({
            ok: true,
            sessionKey,
            model,
            provider: provider || null,
            result,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Gateway without the lock endpoint — client still has per-turn
          // send-stream fields; report soft failure so UI can keep the pick.
          const missing =
            /\b404\b/.test(message) ||
            /\b405\b/.test(message) ||
            /not found/i.test(message) ||
            /not supported/i.test(message)
          if (missing) {
            return json({
              ok: true,
              sessionKey,
              model,
              provider: provider || null,
              locked: false,
              warning: message,
            })
          }
          return json({ ok: false, error: message }, { status: 502 })
        }
      },
    },
  },
})
