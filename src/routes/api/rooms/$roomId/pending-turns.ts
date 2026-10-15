import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  getRoom,
  listPendingTurns,
} from '../../../../server/group-chat/room-store'
import {
  answerPendingTurnWithMessage,
  dismissPendingTurnForRoom,
} from '../../../../server/group-chat/pending-turn-service'

export const Route = createFileRoute('/api/rooms/$roomId/pending-turns')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({
          ok: true,
          room,
          pendingTurns: listPendingTurns(params.roomId),
        })
      },
    },
  },
})
