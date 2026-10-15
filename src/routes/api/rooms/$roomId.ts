import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  deleteRoom,
  getRoom,
  updateRoom,
} from '../../../server/group-chat/room-store'
import {
  deriveMissionWorkspacePath,
  validateWorkspacePathInput,
} from '../../../server/group-chat/resolve-room-cwd'
import { getSwarmMission } from '../../../server/swarm-missions'
import {
  pauseRoom,
  resumeRoom,
} from '../../../server/group-chat/group-chat-runner'

export const Route = createFileRoute('/api/rooms/$roomId')({
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
        return json({ ok: true, room })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const existing = getRoom(params.roomId)
        if (!existing) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        let body: Record<string, unknown>
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }

        // Pause / resume go through dedicated helpers (epoch bump + holds).
        if (body.state === 'paused' && existing.state !== 'paused') {
          const room = pauseRoom(params.roomId)
          return json({ ok: true, room })
        }
        if (body.state === 'active' && existing.state === 'paused') {
          const room = resumeRoom(params.roomId)
          return json({ ok: true, room })
        }

        const patch: Record<string, unknown> = {
          updatedAt: Date.now(),
        }
        if (typeof body.title === 'string') patch.title = body.title
        if (typeof body.state === 'string' && body.state !== existing.state) {
          patch.state = body.state
        }

        if (body.missionId !== undefined) {
          patch.missionId = body.missionId
          if (body.missionId === null) {
            // Unbind — keep current workspacePath so the room becomes ad-hoc.
          } else if (typeof body.missionId === 'string') {
            const derived = deriveMissionWorkspacePath(body.missionId)
            if (derived) patch.workspacePath = derived
          }
        }

        if (body.taskId !== undefined) {
          const taskId = body.taskId
          if (taskId === null) {
            patch.missionId = null
            patch.taskId = null
          } else if (typeof taskId === 'string') {
            const existingMission = getSwarmMission(taskId)
            if (existingMission) {
              patch.missionId = taskId
              const derived = deriveMissionWorkspacePath(taskId)
              if (derived) patch.workspacePath = derived
            }
            patch.taskId = taskId
          }
        }

        if (body.workspacePath !== undefined) {
          const nextMissionId =
            patch.missionId !== undefined
              ? (patch.missionId as string | null)
              : existing.missionId
          if (nextMissionId) {
            return json(
              {
                ok: false,
                error:
                  'Cannot set workspacePath on a mission-bound room; unbind missionId first or use POST /api/rooms/from-mission to refresh',
              },
              { status: 409 },
            )
          }
          try {
            patch.workspacePath = validateWorkspacePathInput(
              body.workspacePath as string | null,
            )
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
        }

        const room = updateRoom(params.roomId, patch)
        if (!room) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        return json({ ok: true, room })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        deleteRoom(params.roomId)
        return json({ ok: true })
      },
    },
  },
})
