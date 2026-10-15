import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { createMission } from '../../../server/task-pipeline/task-service'
import { listSwarmMissions } from '../../../server/swarm-missions'
import { buildMissionSummary } from '../../../server/task-pipeline/mission-serialize'
import type { MissionAssignee } from '../../../server/swarm-missions'

/**
 * GET  /api/missions  → MissionSummary[] (list entity = Mission)
 * POST /api/missions  → create mission (pipeline | assignee XOR)
 */
export const Route = createFileRoute('/api/missions/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const missions = listSwarmMissions(500)
        const list = missions.map((mission) =>
          buildMissionSummary({ mission }),
        )
        return json({ missions: list, tasks: list })
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        let body: {
          title?: string
          spec?: string
          pipelineId?: string
          executionMode?: 'pipeline' | 'assignee'
          assignee?: MissionAssignee
          acceptanceCriteria?: Array<string>
          projectId?: string
          autoDispatch?: boolean
          priority?: number | null
          labels?: Array<string>
        }
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }
        if (!body.title?.trim())
          return json({ error: 'Missing title' }, { status: 400 })

        const hasPipeline = Boolean(body.pipelineId)
        const hasAssignee = Boolean(body.assignee?.id)
        if (hasPipeline && hasAssignee) {
          return json(
            { error: 'pipelineId and assignee are mutually exclusive' },
            { status: 400 },
          )
        }
        if (!hasPipeline && !hasAssignee && body.executionMode !== 'assignee') {
          if (!body.pipelineId) {
            return json(
              { error: 'Provide pipelineId or assignee' },
              { status: 400 },
            )
          }
        }

        try {
          const created = await createMission({
            title: body.title,
            spec: body.spec ?? '',
            acceptanceCriteria: body.acceptanceCriteria ?? [],
            projectId: body.projectId ?? null,
            autoDispatch: body.autoDispatch,
            priority: body.priority,
            labels: body.labels,
            ...(hasAssignee || body.executionMode === 'assignee'
              ? {
                  executionMode: 'assignee' as const,
                  assignee: body.assignee!,
                }
              : {
                  executionMode: 'pipeline' as const,
                  pipelineId: body.pipelineId!,
                }),
          })
          return json(created, { status: 201 })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },
  },
})
