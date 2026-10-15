import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getPendingTurn } from '../../../../server/group-chat/room-store'
import { dismissPendingTurnForRoom } from '../../../../server/group-chat/pending-turn-service'

export const Route = createFileRoute('/api/pending-turns/$turnId/dismiss')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const turn = getPendingTurn(params.turnId)
        if (!turn) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        const updated = dismissPendingTurnForRoom(turn.roomId, turn.id)
        if (!updated) {
          return json({ ok: false, error: 'Failed to dismiss' }, { status: 400 })
        }
        return json({ ok: true, turn: updated })
      },
    },
  },
})
