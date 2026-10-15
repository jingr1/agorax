import { existsSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listKanbanCards } from '../../../server/kanban-backend'
import {
  getSwarmMission,
  listSwarmMissions,
  readyQueuedAssignments,
} from '../../../server/swarm-missions'
import { dispatchReadyAssignments } from '../../../server/task-pipeline/dispatch-ready'
import { getCollabDbPath } from '../../../server/collab-db'
import { openSqliteDatabase } from '../../../server/sqlite-helper'
import type { DispatchReadyResult } from '../../../server/task-pipeline/dispatch-ready'

async function resolveMissionForTaskId(taskId: string) {
  const cards = await listKanbanCards()
  const card = cards.find((c) => c.id === taskId)
  if (!card) return { card: null, mission: null }
  let mission = card.missionId ? getSwarmMission(card.missionId) : null
  if (!mission) {
    const missions = listSwarmMissions(500)
    mission = missions.find((m) => m.taskId === taskId) ?? null
  }
  return { card, mission }
}

/**
 * GET /api/tasks/:taskId → card + pipeline stages (from mission) + runs + events
 * POST /api/tasks/:taskId/start → dispatch ready assignments for the task's mission
 */
export const Route = createFileRoute('/api/tasks/$taskId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const taskId = params.taskId
        const { card, mission } = await resolveMissionForTaskId(taskId)
        if (!card)
          return json({ error: `Task not found: ${taskId}` }, { status: 404 })
        if (!mission) {
          return json({ task: card, pipeline: null, runs: [], events: [] })
        }

        // task_runs for this mission (collab.db may not exist in P2a tests).
        const dbPath = getCollabDbPath()
        let runs: Array<Record<string, unknown>> = []
        if (existsSync(dbPath)) {
          const db = openSqliteDatabase(dbPath, true)
          try {
            runs = db
              .prepare(
                'SELECT * FROM task_runs WHERE mission_id = ? ORDER BY started_at',
              )
              .all(mission.id)
          } finally {
            db.close()
          }
        }

        return json({
          task: {
            ...card,
            title: mission.title.trim() ? mission.title.trim() : card.title,
          },
          pipeline: {
            id: mission.pipelineId ?? null,
            specVersion: mission.specVersion ?? 1,
            stages: mission.assignments.map((a) => ({
              assignmentId: a.id,
              stageKey: a.stageKey ?? null,
              agent: a.workerId,
              state: a.state,
              stale:
                a.briefSpecVersion != null && mission.specVersion != null
                  ? a.briefSpecVersion !== mission.specVersion
                  : false,
              dependsOn: a.dependsOn,
              dispatchedAt: a.dispatchedAt,
              completedAt: a.completedAt,
              createdByWorkerId: a.createdByWorkerId ?? null,
              dispatchable: a.dispatchable !== false,
              externalRef: a.externalRef ?? null,
              workspacePath: a.workspacePath ?? null,
            })),
          },
          runs,
          events: mission.events,
        })
      },

      POST: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const taskId = params.taskId
        const { card, mission } = await resolveMissionForTaskId(taskId)
        if (!card)
          return json({ error: `Task not found: ${taskId}` }, { status: 404 })
        if (!mission) {
          return json(
            { error: `No mission bound to task ${taskId}` },
            { status: 400 },
          )
        }
        const ready = readyQueuedAssignments(mission.id)
        if (ready.length === 0) {
          const states = mission.assignments.map((a) => `${a.workerId}:${a.state}`)
          return json(
            {
              error: 'No ready assignments to dispatch',
              missionId: mission.id,
              states,
            },
            { status: 400 },
          )
        }
        try {
          const result: DispatchReadyResult = await dispatchReadyAssignments(
            mission.id,
          )
          return json(result, { status: 200 })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      },
    },
  },
})
