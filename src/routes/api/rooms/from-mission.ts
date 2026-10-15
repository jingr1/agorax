import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { ensureRoomForMission } from '../../../server/group-chat/ensure-room-for-mission'

export const Route = createFileRoute('/api/rooms/from-mission')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: { missionId?: string }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const missionId = String(body.missionId ?? '').trim()
        if (!missionId) {
          return json(
            { ok: false, error: 'missionId required' },
            { status: 400 },
          )
        }
        try {
          const result = await ensureRoomForMission({ missionId })
          return json({
            ok: true,
            room: result.room,
            created: result.created,
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          const status = /not found/i.test(message) ? 404 : 400
          return json({ ok: false, error: message }, { status })
        }
      },
    },
  },
})
