import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { forgetSession } from '../../../../../server/group-chat/agent-session-manager'
import {
  getParticipantBySlug,
  getRoom,
  removeParticipant,
} from '../../../../../server/group-chat/room-store'

export const Route = createFileRoute(
  '/api/rooms/$roomId/participants/$participantId',
)({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const room = getRoom(params.roomId)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        const participant = getParticipantBySlug(
          params.roomId,
          params.participantId,
        )
        if (!participant) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        removeParticipant(params.roomId, params.participantId)
        forgetSession(params.roomId, params.participantId)
        return json({ ok: true })
      },
    },
  },
})
