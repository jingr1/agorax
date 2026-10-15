import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '@/server/auth-middleware'
import { getSwarmMission } from '@/server/swarm-missions'
import { buildTaskRuntimeSnapshot } from '@/server/task-pipeline/mission-serialize'

/**
 * GET /api/missions/:missionId/tasks/:taskId/runtime
 * Symphony-aligned Task runtime stub (Issue ≈ Task).
 */
export const Route = createFileRoute(
  '/api/missions/$missionId/tasks/$taskId/runtime',
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const mission = getSwarmMission(params.missionId)
        if (!mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }
        const assignment = mission.assignments.find(
          (a) => a.id === params.taskId,
        )
        if (!assignment) {
          return json(
            { error: `Task not found: ${params.taskId}` },
            { status: 404 },
          )
        }
        return json(buildTaskRuntimeSnapshot({ mission, assignment }))
      },
    },
  },
})
