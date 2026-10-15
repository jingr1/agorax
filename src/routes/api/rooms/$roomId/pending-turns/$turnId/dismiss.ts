import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../server/auth-middleware'
import { getRoom } from '../../../../../../server/group-chat/room-store'
import { dismissPendingTurnForRoom } from '../../../../../../server/group-chat/pending-turn-service'

export const Route = createFileRoute(
  '/api/rooms/$roomId/pending-turns/$turnId/dismiss',
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
        const updated = dismissPendingTurnForRoom(params.roomId, params.turnId)
        if (!updated) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({ ok: true, turn: updated })
      },
    },
  },
})
