import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { createRoom, listRooms } from '../../server/group-chat/room-store'
import {
  deriveMissionWorkspacePath,
  validateWorkspacePathInput,
} from '../../server/group-chat/resolve-room-cwd'
import { getSwarmMission } from '../../server/swarm-missions'

export const Route = createFileRoute('/api/rooms')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        return json({ ok: true, rooms: listRooms() })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        let body: {
          title?: string
          missionId?: string | null
          taskId?: string | null
          workspacePath?: string | null
        }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const title = String(body.title ?? '').trim()
        if (!title) {
          return json({ ok: false, error: 'title required' }, { status: 400 })
        }
        const taskId = body.taskId ?? null
        const existingMission = taskId ? getSwarmMission(taskId) : null
        const missionId = existingMission
          ? taskId
          : (body.missionId ?? null)

        let workspacePath: string | null = null
        try {
          if (missionId) {
            // Mission-bound rooms derive path; ignore client workspacePath.
            workspacePath = deriveMissionWorkspacePath(missionId)
          } else if (body.workspacePath !== undefined) {
            workspacePath = validateWorkspacePathInput(body.workspacePath)
          }
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Invalid workspacePath',
            },
            { status: 400 },
          )
        }

        const room = createRoom({
          title,
          missionId,
          taskId,
          workspacePath,
        })
        return json({ ok: true, room })
      },
    },
  },
})
