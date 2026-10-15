import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../server/auth-middleware'
import { getRoom } from '../../../../../../server/group-chat/room-store'
import { answerPendingTurnWithMessage } from '../../../../../../server/group-chat/pending-turn-service'

export const Route = createFileRoute(
  '/api/rooms/$roomId/pending-turns/$turnId/answer',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        let body: { answerText?: string }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const answerText = String(body.answerText ?? '').trim()
        if (!answerText) {
          return json(
            { ok: false, error: 'answerText required' },
            { status: 400 },
          )
        }
        const result = await answerPendingTurnWithMessage({
          roomId: params.roomId,
          turnId: params.turnId,
          answerText,
        })
        if (!result) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({ ok: true, turn: result.turn, message: result.message })
      },
    },
  },
})
