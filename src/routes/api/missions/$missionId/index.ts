import { existsSync } from 'node:fs'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  getSwarmMission,
  patchMissionFields,
  readyQueuedAssignments,
  type MissionAssignee,
  type SwarmMission,
} from '../../../../server/swarm-missions'
import { dispatchReadyAssignments } from '../../../../server/task-pipeline/dispatch-ready'
import { deleteMission } from '../../../../server/task-pipeline/task-service'
import { getCollabDbPath } from '../../../../server/collab-db'
import { openSqliteDatabase } from '../../../../server/sqlite-helper'
import {
  buildMissionSummary,
  serializeMissionTask,
} from '../../../../server/task-pipeline/mission-serialize'
import type { DispatchReadyResult } from '../../../../server/task-pipeline/dispatch-ready'
import { getProject } from '../../../../server/task-pipeline/projects'
import type { MissionStatus } from '../../../../server/task-pipeline/lane-sync'
import { normalizeMissionStatus } from '../../../../server/task-pipeline/lane-sync'

function resolveMission(id: string): SwarmMission | null {
  return getSwarmMission(id)
}

/**
 * GET    /api/missions/:missionId → mission detail + tasks
 * POST   /api/missions/:missionId → dispatch ready tasks
 * PATCH  /api/missions/:missionId → update configurable fields
 * DELETE /api/missions/:missionId → delete mission
 */
export const Route = createFileRoute('/api/missions/$missionId/')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const mission = resolveMission(params.missionId)
        if (!mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }

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

        const summary = buildMissionSummary({ mission })

        return json({
          mission: summary,
          task: {
            id: mission.id,
            title: mission.title,
            spec: mission.spec ?? '',
            acceptanceCriteria: mission.acceptanceCriteria ?? [],
            status: summary.lane,
            missionId: mission.id,
          },
          tasks: mission.assignments.map(serializeMissionTask),
          pipeline: {
            id: mission.pipelineId ?? null,
            specVersion: mission.specVersion ?? 1,
            stages: mission.assignments.map((a) => ({
              assignmentId: a.id,
              stageKey: a.stageKey ?? null,
              agent: a.workerId,
              state: a.state,
              createdByWorkerId: a.createdByWorkerId ?? null,
              stale:
                a.briefSpecVersion != null && mission.specVersion != null
                  ? a.briefSpecVersion !== mission.specVersion
                  : false,
              dependsOn: a.dependsOn,
              dispatchedAt: a.dispatchedAt,
              completedAt: a.completedAt,
            })),
          },
          runs,
          events: mission.events,
        })
      },

      POST: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const mission = resolveMission(params.missionId)
        if (!mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }
        const ready = readyQueuedAssignments(mission.id)
        if (ready.length === 0) {
          return json(
            {
              error: 'No ready assignments to dispatch',
              missionId: mission.id,
              states: mission.assignments.map(
                (a) => `${a.workerId}:${a.state}`,
              ),
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

      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        const mission = resolveMission(params.missionId)
        if (!mission) {
          return json(
            { error: `Mission not found: ${params.missionId}` },
            { status: 404 },
          )
        }

        let body: {
          title?: string
          spec?: string
          acceptanceCriteria?: Array<string>
          assignee?: MissionAssignee | null
          roomId?: string | null
          projectId?: string | null
          priority?: number | null
          labels?: Array<string>
          boardLane?: MissionStatus | null
          status?: MissionStatus | null
        }
        try {
          body = await request.json()
        } catch {
          return json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (body.projectId != null && body.projectId !== '') {
          if (!getProject(body.projectId)) {
            return json(
              { error: `Unknown project: ${body.projectId}` },
              { status: 400 },
            )
          }
        }

        if (
          body.assignee != null &&
          (!body.assignee.type || !body.assignee.id?.trim())
        ) {
          return json(
            { error: 'assignee requires type and id' },
            { status: 400 },
          )
        }

        if (
          body.priority !== undefined &&
          body.priority !== null &&
          (!Number.isFinite(body.priority) ||
            body.priority < 0 ||
            body.priority > 4)
        ) {
          return json(
            { error: 'priority must be 0–4 or null' },
            { status: 400 },
          )
        }

        if (
          body.acceptanceCriteria !== undefined &&
          !Array.isArray(body.acceptanceCriteria)
        ) {
          return json(
            { error: 'acceptanceCriteria must be an array of strings' },
            { status: 400 },
          )
        }

        const statusPin =
          body.status !== undefined
            ? body.status
            : body.boardLane !== undefined
              ? body.boardLane
              : undefined
        const normalizedPin =
          statusPin === undefined
            ? undefined
            : statusPin === null
              ? null
              : normalizeMissionStatus(statusPin)

        const patched = patchMissionFields({
          missionId: mission.id,
          title: body.title,
          spec: body.spec,
          acceptanceCriteria: body.acceptanceCriteria,
          assignee: body.assignee,
          roomId: body.roomId,
          projectId: body.projectId,
          priority: body.priority,
          labels: body.labels,
          boardLane: normalizedPin,
        })
        if (!patched) {
          return json({ error: 'Failed to patch mission' }, { status: 500 })
        }

        return json({
          ok: true,
          mission: buildMissionSummary({ mission: patched }),
          task: {
            id: patched.id,
            title: patched.title,
            spec: patched.spec ?? '',
            acceptanceCriteria: patched.acceptanceCriteria ?? [],
            status: buildMissionSummary({ mission: patched }).lane,
            missionId: patched.id,
          },
        })
      },

      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        try {
          const result = await deleteMission(params.missionId)
          return json({ ok: true, ...result })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          const notFound = message.startsWith('Mission not found:')
          return json(
            { error: message },
            { status: notFound ? 404 : 500 },
          )
        }
      },
    },
  },
})
