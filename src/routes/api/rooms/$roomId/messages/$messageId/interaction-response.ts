import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../server/auth-middleware'
import { respondToManagedInteractionCard } from '../../../../../../server/group-chat/managed-interaction-cards'

/**
 * Writeback for a group-chat managed interaction card. The card message
 * carries the canonical interaction identity (agentSessionId/turnId/requestId);
 * the response goes straight to the daemon via the managed HTTP client, and
 * the card is refreshed from the canonical interaction list afterwards.
 */
export const Route = createFileRoute(
  '/api/rooms/$roomId/messages/$messageId/interaction-response',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const roomId = params.roomId.trim()
        const messageId = params.messageId.trim()
        if (!roomId || !messageId) {
          return json({ ok: false, error: 'room and message ids are required' }, { status: 400 })
        }
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) {
          return json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
        }
        const action = typeof body.action === 'string' ? body.action.trim() : ''
        const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : ''
        const payload =
          body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
            ? (body.payload as Record<string, unknown>)
            : undefined
        if (!action && !optionId && !payload) {
          return json({ ok: false, error: 'an interaction response is required' }, { status: 400 })
        }

        const result = await respondToManagedInteractionCard({
          roomId,
          messageId,
          ...(action ? { action } : {}),
          ...(optionId ? { optionId } : {}),
          ...(payload ? { payload } : {}),
        })
        if (!result.ok) {
          return json({ ok: false, error: result.error }, { status: result.status })
        }
        return json({ ok: true, status: result.status })
      },
    },
  },
})
