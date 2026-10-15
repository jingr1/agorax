/**
 * MissionRepository — abstraction over mission / assignment storage.
 *
 * Phase 1 (short-term): SQLite becomes the source of truth for mission and
 * assignment state; the legacy JSON file is kept as an export cache.
 *
 * The interface mirrors the public API surface of `src/server/swarm-missions.ts`
 * so that module can act as a thin facade while preserving backwards
 * compatibility for callers.
 */
import {
  ensureCollabDb,
  createCollabId,
  getCollabDbPath,
} from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import { SWARM_MISSIONS_PATH } from '../swarm-environment'
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  MissionAssignee,
  MissionExecutionMode,
  SwarmMission,
  SwarmMissionAssignment,
  SwarmMissionEvent,
  SwarmCheckpointReport,
  TaskExternalRef,
} from '../swarm-missions'
import type { ParsedSwarmCheckpoint } from '../swarm-checkpoints'
import { deriveMissionStatus } from './mission-status'
import {
  TERMINAL_ASSIGNMENT_STATES,
  type MissionStatus,
  type SwarmMissionAssignmentState,
} from '../schema'
import {
  fireCheckpointReviewHook,
  fireCheckpointTerminalHook,
} from './mission-hooks'

function isTerminal(assignment: SwarmMissionAssignment): boolean {
  return ['done', 'cancelled', 'checkpointed', 'blocked', 'needs_input'].includes(
    assignment.state,
  )
}

export type CreateOrUpdateMissionResult = SwarmMission & { _created?: boolean }

export type RecordCheckpointResult =
  | (SwarmMission & { _completed?: boolean; _ignoredReason?: string })
  | null

export type MissionRepository = {
  listMissions(limit?: number): Array<SwarmMission>
  getMission(missionId: string): SwarmMission | null
  createOrUpdateMission(input: {
    missionId?: string | null
    title: string
    spec?: string
    acceptanceCriteria?: Array<string>
    projectId?: string | null
    workspaceMode?: string | null
    executionMode?: MissionExecutionMode | null
    assignee?: MissionAssignee | null
    roomId?: string | null
    pipelineId?: string | null
    priority?: number | null
    labels?: Array<string>
    boardLane?: SwarmMission['boardLane']
    assignments: Array<{
      workerId: string
      task: string
      rationale?: string | null
      dependsOn?: Array<string>
      reviewRequired?: boolean
      requires?: Array<string>
      createdByWorkerId?: string | null
      dispatchable?: boolean
      externalRef?: TaskExternalRef | null
      workspacePath?: string | null
      stageKey?: string | null
    }>
  }): CreateOrUpdateMissionResult
  markAssignmentDispatched(input: {
    missionId: string
    workerId: string
    task: string
    assignmentId?: string
    source?: string | null
    author?: string | null
    overrideWorkerId?: string
  }): SwarmMission | null
  recordCheckpoint(input: {
    missionId?: string | null
    assignmentId?: string | null
    workerId: string
    checkpoint: ParsedSwarmCheckpoint
    source?: string | null
  }): RecordCheckpointResult
  recordAssignmentBlocked(input: {
    missionId?: string | null
    assignmentId?: string | null
    workerId: string
    reason?: string | null
    source?: string | null
  }): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null
  appendContinuation(input: {
    missionId?: string | null
    workerId: string
    task: string
    rationale: string
    dependsOn?: Array<string>
    stageKey?: string | null
  }): SwarmMission | null
  readyQueuedAssignments(missionId: string): Array<SwarmMissionAssignment>
  requeueAssignment(input: {
    missionId: string
    assignmentId: string
    reason: string
  }): SwarmMission | null
  requeueAssignmentForRework(input: {
    missionId: string
    assignmentId: string
    reason: string
  }): SwarmMission | null
  setAssignmentBaseRef(
    missionId: string,
    assignmentId: string,
    baseRef: string,
  ): SwarmMission | null
  setAssignmentHeadSha(
    missionId: string,
    assignmentId: string,
    headSha: string,
  ): SwarmMission | null
  setMissionTaskId(input: {
    missionId: string
    taskId: string | null
  }): SwarmMission | null
  updateMissionRoomId(input: {
    missionId: string
    roomId: string | null
  }): SwarmMission | null
  patchMissionFields(input: {
    missionId: string
    title?: string
    spec?: string
    acceptanceCriteria?: Array<string>
    executionMode?: MissionExecutionMode | null
    assignee?: MissionAssignee | null
    roomId?: string | null
    pipelineId?: string | null
    projectId?: string | null
    priority?: number | null
    labels?: Array<string>
    boardLane?: SwarmMission['boardLane']
  }): SwarmMission | null
  deleteMission(missionId: string): boolean
  rewriteAssignmentDependencies(input: {
    missionId: string
    dependsOnByAssignmentId: Record<string, Array<string>>
    stageKeyByAssignmentId?: Record<string, string>
    requiresByAssignmentId?: Record<string, Array<string> | undefined>
    briefSpecVersion?: number
    pipelineId?: string
    taskId?: string
    specVersion?: number
    executionMode?: MissionExecutionMode | null
    createdByWorkerId?: string | null
  }): SwarmMission | null
  cancelAssignment(input: {
    missionId?: string | null
    assignmentId?: string | null
    workerId?: string | null
    actor?: string | null
    reason?: string | null
  }): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null
  appendOrchestratorEvent(input: {
    missionId: string
    message: string
    data?: Record<string, unknown>
  }): SwarmMission | null
  cancelMission(input: {
    missionId?: string | null
    actor?: string | null
    reason?: string | null
  }): { mission: SwarmMission; cancelledAssignmentIds: Array<string>; changed: boolean } | null
  markAssignmentReviewed(input: {
    missionId?: string | null
    assignmentId: string
    reviewerId?: string
  }): SwarmMission | null
  markAssignmentsReviewedByWorker(input: {
    missionId?: string | null
    reviewerId: string
    excludeAssignmentId?: string | null
  }): { mission: SwarmMission; reviewedAssignmentIds: Array<string> } | null
  listReports(input?: {
    missionId?: string | null
    workerId?: string | null
    limit?: number
  }): Array<SwarmCheckpointReport>
  archiveStaleMissions(staleMs?: number): { archivedIds: Array<string>; count: number }
  exportToJson?(): Array<SwarmMission>
}

// ── SQLite implementation ────────────────────────────────────────────────

function now(): number {
  return Date.now()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function boolToInt(value: boolean | null | undefined): number {
  return value ? 1 : 0
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function writeJsonCache(missions: Array<SwarmMission>): void {
  try {
    mkdirSync(dirname(SWARM_MISSIONS_PATH), { recursive: true })
    const tmp = `${SWARM_MISSIONS_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, missions }, null, 2) + '\n',
    )
    renameSync(tmp, SWARM_MISSIONS_PATH)
  } catch (error) {
    console.error(
      '[mission-repository] JSON cache write failed:',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function missionRowToMission(row: Record<string, unknown>): SwarmMission {
  return {
    id: String(row.id),
    title: String(row.title),
    state: String(row.state) as MissionStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    assignments: [], // hydrated separately
    events: [], // hydrated separately
    spec: row.spec == null ? '' : String(row.spec),
    acceptanceCriteria: parseJson(String(row.acceptance_criteria), []),
    specVersion: row.spec_version == null ? 1 : Number(row.spec_version),
    pipelineId: row.pipeline_id == null ? null : String(row.pipeline_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    workspaceMode: row.workspace_mode == null ? null : String(row.workspace_mode),
    executionMode:
      row.execution_mode == null
        ? null
        : (String(row.execution_mode) as MissionExecutionMode),
    assignee:
      row.assignee_type == null
        ? null
        : ({
            type: String(row.assignee_type) as 'agent' | 'chat_group',
            id: String(row.assignee_id ?? ''),
          } satisfies MissionAssignee),
    roomId: row.room_id == null ? null : String(row.room_id),
    priority: row.priority == null ? null : Number(row.priority),
    labels: parseJson(String(row.labels), []),
    boardLane: row.board_lane == null ? null : (String(row.board_lane) as MissionStatus),
  }
}

function assignmentRowToAssignment(
  row: Record<string, unknown>,
): SwarmMissionAssignment {
  return {
    id: String(row.id),
    workerId: String(row.worker_id),
    task: String(row.task),
    rationale: row.rationale == null ? null : String(row.rationale),
    dependsOn: parseJson(String(row.depends_on), []),
    reviewRequired: Boolean(row.review_required),
    state: String(row.state) as SwarmMissionAssignmentState,
    dispatchedAt: row.dispatched_at == null ? null : Number(row.dispatched_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    checkpoint: row.checkpoint_json == null ? null : parseJson(String(row.checkpoint_json), null),
    stageKey: row.stage_key == null ? null : String(row.stage_key),
    briefSpecVersion:
      row.brief_spec_version == null ? null : Number(row.brief_spec_version),
    requires: parseJson(String(row.requires), []),
    createdByWorkerId:
      row.created_by_worker_id == null
        ? 'system:pipeline'
        : String(row.created_by_worker_id),
    dispatchable: row.dispatchable == null ? true : Boolean(row.dispatchable),
    externalRef: row.external_ref_json == null ? null : parseJson(String(row.external_ref_json), null),
    workspacePath: row.workspace_path == null ? null : String(row.workspace_path),
    baseRef: row.base_ref == null ? null : String(row.base_ref),
    headSha: row.head_sha == null ? null : String(row.head_sha),
  }
}

function eventRowToEvent(row: Record<string, unknown>): SwarmMissionEvent {
  return {
    id: String(row.id),
    type: String(row.type) as SwarmMissionEvent['type'],
    at: Number(row.at),
    workerId: row.worker_id == null ? undefined : String(row.worker_id),
    assignmentId:
      row.assignment_id == null ? undefined : String(row.assignment_id),
    message: String(row.message),
    data: row.data_json == null ? undefined : parseJson(String(row.data_json), {}),
  }
}

export class SqliteMissionRepository implements MissionRepository {
  private readonly dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getCollabDbPath()
    ensureCollabDb(this.dbPath)
  }

  private db() {
    return openSqliteDatabase(this.dbPath, false)
  }

  private dbReadonly() {
    return openSqliteDatabase(this.dbPath, true)
  }

  private getConnection() {
    return openSqliteDatabase(this.dbPath, false)
  }

  private syncJsonCache(): void {
    try {
      writeJsonCache(this.listMissions(1000))
    } catch (error) {
      console.error(
        '[SqliteMissionRepository] cache sync failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private withTransaction<T>(fn: (db: ReturnType<typeof openSqliteDatabase>) => T): T {
    const db = this.db()
    try {
      db.exec('BEGIN')
      const result = fn(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore rollback failure
      }
      throw error
    } finally {
      db.close()
    }
  }

  private withWriteSync<T>(fn: (db: ReturnType<typeof openSqliteDatabase>) => T): T {
    const result = this.withTransaction(fn)
    this.syncJsonCache()
    return result
  }

  private hydrateMission(db: ReturnType<typeof openSqliteDatabase>, missionId: string): SwarmMission {
    const missionRow = db
      .prepare('SELECT * FROM missions WHERE id = ?')
      .get(missionId) as Record<string, unknown> | undefined
    if (!missionRow) {
      throw new Error(`Mission not found during hydration: ${missionId}`)
    }
    const mission = missionRowToMission(missionRow)
    mission.assignments = db
      .prepare('SELECT * FROM assignments WHERE mission_id = ? ORDER BY dispatched_at ASC, id ASC')
      .all(missionId)
      .map((row) => assignmentRowToAssignment(row as Record<string, unknown>))
    mission.events = db
      .prepare('SELECT * FROM mission_events WHERE mission_id = ? ORDER BY at ASC, id ASC')
      .all(missionId)
      .map((row) => eventRowToEvent(row as Record<string, unknown>))
    return mission
  }

  private persistEvent(
    db: ReturnType<typeof openSqliteDatabase>,
    event: SwarmMissionEvent,
    missionId: string,
  ): void {
    db.prepare(
      `INSERT INTO mission_events
       (id, mission_id, type, at, worker_id, assignment_id, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      missionId,
      event.type,
      event.at,
      event.workerId ?? null,
      event.assignmentId ?? null,
      event.message,
      event.data == null ? null : serializeJson(event.data),
    )
  }

  listMissions(limit = 20): Array<SwarmMission> {
    const cap = Math.max(1, Math.min(100, limit))
    const db = this.dbReadonly()
    try {
      const rows = db
        .prepare('SELECT id FROM missions ORDER BY updated_at DESC LIMIT ?')
        .all(cap) as Array<{ id: string }>
      return rows.map((row) => this.hydrateMission(db, row.id))
    } finally {
      db.close()
    }
  }

  getMission(missionId: string): SwarmMission | null {
    const db = this.dbReadonly()
    try {
      const exists = db
        .prepare('SELECT 1 as present FROM missions WHERE id = ?')
        .get(missionId) as { present: number } | undefined
      if (!exists) return null
      return this.hydrateMission(db, missionId)
    } finally {
      db.close()
    }
  }

  createOrUpdateMission(input: MissionRepository['createOrUpdateMission'] extends (arg: infer P) => unknown ? P : never): CreateOrUpdateMissionResult {
    return this.withWriteSync((db) => {
      const missionId = input.missionId?.trim() || shortId('mission')
      const createdAt = now()
      const existing = db
        .prepare('SELECT created_at FROM missions WHERE id = ?')
        .get(missionId) as { created_at: number } | undefined

      if (!existing) {
        db.prepare(
          `INSERT INTO missions
           (id, title, state, spec, acceptance_criteria, spec_version, pipeline_id,
            project_id, workspace_mode, execution_mode, assignee_type, assignee_id,
            room_id, priority, labels, board_lane, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          missionId,
          input.title || 'Untitled swarm mission',
          'todo',
          input.spec ?? '',
          serializeJson(input.acceptanceCriteria ?? []),
          1,
          input.pipelineId ?? null,
          input.projectId ?? null,
          input.workspaceMode ?? null,
          input.executionMode ?? null,
          input.assignee?.type ?? null,
          input.assignee?.id ?? null,
          input.roomId ?? null,
          input.priority ?? null,
          serializeJson(input.labels ?? []),
          input.boardLane ?? null,
          createdAt,
          createdAt,
        )
        this.persistEvent(
          db,
          {
            id: shortId('evt'),
            type: 'created',
            at: createdAt,
            message: `Mission created: ${input.title || missionId}`,
          },
          missionId,
        )
      } else {
        db.prepare(
          `UPDATE missions SET
            title = COALESCE(?, title),
            spec = ?,
            acceptance_criteria = ?,
            project_id = ?,
            workspace_mode = ?,
            execution_mode = ?,
            assignee_type = ?,
            assignee_id = ?,
            room_id = ?,
            pipeline_id = ?,
            priority = ?,
            labels = ?,
            board_lane = ?,
            updated_at = ?
           WHERE id = ?`,
        ).run(
          input.title || null,
          input.spec ?? '',
          serializeJson(input.acceptanceCriteria ?? []),
          input.projectId ?? null,
          input.workspaceMode ?? null,
          input.executionMode ?? null,
          input.assignee?.type ?? null,
          input.assignee?.id ?? null,
          input.roomId ?? null,
          input.pipelineId ?? null,
          input.priority ?? null,
          serializeJson(input.labels ?? []),
          input.boardLane ?? null,
          now(),
          missionId,
        )
      }

      const mission = this.hydrateMission(db, missionId)
      let createdAny = false
      for (const assignment of input.assignments) {
        const hasActive = mission.assignments.some(
          (item) => item.workerId === assignment.workerId && !isTerminal(item),
        )
        if (hasActive) continue
        const id = shortId('assign')
        db.prepare(
          `INSERT INTO assignments
           (id, mission_id, worker_id, task, rationale, depends_on, review_required,
            state, requires, created_by_worker_id, dispatchable, external_ref_json,
            workspace_path, stage_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          missionId,
          assignment.workerId,
          assignment.task,
          assignment.rationale ?? null,
          serializeJson(assignment.dependsOn ?? []),
          boolToInt(assignment.reviewRequired ?? false),
          'queued',
          serializeJson(assignment.requires ?? []),
          assignment.createdByWorkerId ?? 'system:pipeline',
          boolToInt(assignment.dispatchable !== false),
          assignment.externalRef == null ? null : serializeJson(assignment.externalRef),
          assignment.workspacePath ?? null,
          assignment.stageKey ?? null,
        )
        createdAny = true
      }

      if (createdAny) {
        const updated = this.hydrateMission(db, missionId)
        this.assertAcyclicDependencies(updated.assignments)
      }

      const final = this.hydrateMission(db, missionId)
      final.state = deriveMissionStatus(final.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        final.state,
        now(),
        missionId,
      )
      return Object.assign(this.hydrateMission(db, missionId), {
        _created: !existing,
      })
    })
  }

  markAssignmentDispatched(input: MissionRepository['markAssignmentDispatched'] extends (arg: infer P) => unknown ? P : never): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      if (mission.state === 'cancelled' || mission.state === 'done') return mission
      const assignment = input.assignmentId
        ? mission.assignments.find((a) => a.id === input.assignmentId)
        : mission.assignments.find(
            (a) => a.workerId === input.workerId && a.task === input.task,
          )
      if (!assignment) return null
      if (isTerminal(assignment)) return mission

      assignment.state = 'dispatched'
      assignment.dispatchedAt = now()
      if (input.overrideWorkerId) {
        assignment.workerId = input.overrideWorkerId
      }
      assignment.checkpoint = null
      assignment.completedAt = null

      db.prepare(
        `UPDATE assignments SET
          state = ?, dispatched_at = ?, worker_id = ?, checkpoint_json = NULL,
          completed_at = NULL
         WHERE id = ?`,
      ).run(
        assignment.state,
        assignment.dispatchedAt,
        assignment.workerId,
        assignment.id,
      )

      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'assignment_dispatched',
          at: now(),
          workerId: input.workerId,
          assignmentId: assignment.id,
          message: `Dispatched ${assignment.id} to ${input.workerId}`,
          data: {
            task: assignment.task,
            source: input.source?.trim() || 'swarm-dispatch',
            author: input.author?.trim() || 'aurora',
          },
        },
        mission.id,
      )

      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        mission.id,
      )
      return this.hydrateMission(db, mission.id)
    })
  }

  recordCheckpoint(
    input: MissionRepository['recordCheckpoint'] extends (arg: infer P) => unknown ? P : never,
  ): RecordCheckpointResult {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      if (mission.state === 'cancelled')
        return Object.assign(mission, { _ignoredReason: 'mission cancelled' })

      const assignment =
        (input.assignmentId
          ? mission.assignments.find((a) => a.id === input.assignmentId)
          : null) ??
        [...mission.assignments]
          .reverse()
          .find(
            (item) => item.workerId === input.workerId && item.state !== 'done',
          ) ??
        [...mission.assignments]
          .reverse()
          .find((item) => item.workerId === input.workerId)
      if (!assignment) return null
      if (assignment.state === 'cancelled')
        return Object.assign(mission, { _ignoredReason: 'assignment cancelled' })
      if (assignment.state === 'done')
        return Object.assign(mission, { _ignoredReason: 'assignment done' })

      const checkpoint = input.checkpoint
      assignment.checkpoint = checkpoint as SwarmMissionAssignment['checkpoint']
      assignment.completedAt = now()
      assignment.state =
        checkpoint.stateLabel === 'BLOCKED'
          ? 'blocked'
          : checkpoint.stateLabel === 'NEEDS_INPUT'
            ? 'needs_input'
            : checkpoint.stateLabel === 'IN_PROGRESS'
              ? 'dispatched'
              : checkpoint.reviewOutcome === 'changes_requested'
                ? 'reviewing'
                : 'checkpointed'

      db.prepare(
        `UPDATE assignments SET
          state = ?, completed_at = ?, checkpoint_json = ?
         WHERE id = ?`,
      ).run(
        assignment.state,
        assignment.completedAt,
        serializeJson(checkpoint),
        assignment.id,
      )

      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'checkpoint',
          at: now(),
          workerId: input.workerId,
          assignmentId: assignment.id,
          message: `${input.workerId} checkpointed: ${checkpoint.stateLabel}`,
          data: {
            missionId: mission.id,
            assignmentId: assignment.id,
            workerId: input.workerId,
            recordedAt: now(),
            stateLabel: checkpoint.stateLabel,
            checkpointStatus: checkpoint.checkpointStatus,
            runtimeState: checkpoint.runtimeState,
            filesChanged: checkpoint.filesChanged,
            commandsRun: checkpoint.commandsRun,
            result: checkpoint.result,
            blocker: checkpoint.blocker,
            nextAction: checkpoint.nextAction,
            source: input.source?.trim() || 'unknown',
          },
        },
        mission.id,
      )

      const previousState = mission.state
      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      const completed = updated.state === 'done' && previousState !== 'done'
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        mission.id,
      )

      if (checkpoint.reviewOutcome) {
        fireCheckpointReviewHook(
          mission.id,
          assignment.id,
          input.workerId,
          checkpoint as ParsedSwarmCheckpoint,
          input.source,
        )
      }
      if (TERMINAL_ASSIGNMENT_STATES.includes(assignment.state)) {
        fireCheckpointTerminalHook(
          mission.id,
          assignment.id,
          input.workerId,
          checkpoint as ParsedSwarmCheckpoint,
          input.source,
        )
      }

      return Object.assign(this.hydrateMission(db, mission.id), {
        _completed: completed,
      })
    })
  }

  recordAssignmentBlocked(
    input: MissionRepository['recordAssignmentBlocked'] extends (arg: infer P) => unknown ? P : never,
  ): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      if (mission.state === 'cancelled' || mission.state === 'done') return null
      const assignment =
        (input.assignmentId
          ? mission.assignments.find((a) => a.id === input.assignmentId)
          : null) ??
        [...mission.assignments]
          .reverse()
          .find(
            (item) =>
              item.workerId === input.workerId && !isTerminal(item),
          ) ??
        [...mission.assignments]
          .reverse()
          .find((item) => item.workerId === input.workerId)
      if (!assignment) return null
      if (assignment.state === 'cancelled' || assignment.state === 'done')
        return { mission, assignment, changed: false }

      const reason =
        input.reason?.trim() ||
        'Dispatch failed before a worker checkpoint was recorded.'
      const blockedAt = now()
      const checkpoint: ParsedSwarmCheckpoint = {
        stateLabel: 'BLOCKED',
        runtimeState: 'blocked',
        checkpointStatus: 'blocked',
        filesChanged: 'none',
        commandsRun: 'none',
        result: null,
        blocker: reason,
        nextAction: 'Fix blocker and retry dispatch.',
        reviewOutcome: null,
        raw: `STATE: BLOCKED\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: none\nBLOCKER: ${reason}\nNEXT_ACTION: Fix blocker and retry dispatch.`,
      }

      const changed =
        assignment.state !== 'blocked' || assignment.checkpoint?.raw !== checkpoint.raw
      assignment.state = 'blocked'
      assignment.completedAt = blockedAt
      assignment.checkpoint = checkpoint

      db.prepare(
        `UPDATE assignments SET
          state = ?, completed_at = ?, checkpoint_json = ?
         WHERE id = ?`,
      ).run(assignment.state, blockedAt, serializeJson(checkpoint), assignment.id)

      if (changed) {
        this.persistEvent(
          db,
          {
            id: shortId('evt'),
            type: 'blocked',
            at: blockedAt,
            workerId: input.workerId,
            assignmentId: assignment.id,
            message: `${input.workerId} blocked: ${reason}`,
            data: {
              missionId: mission.id,
              assignmentId: assignment.id,
              workerId: input.workerId,
              recordedAt: blockedAt,
              stateLabel: 'BLOCKED',
              checkpointStatus: 'blocked',
              runtimeState: 'blocked',
              filesChanged: 'none',
              commandsRun: 'none',
              result: null,
              blocker: reason,
              nextAction: 'Fix blocker and retry dispatch.',
              source: input.source?.trim() || 'unknown',
            },
          },
          mission.id,
        )
      }

      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        blockedAt,
        mission.id,
      )
      return { mission: this.hydrateMission(db, mission.id), assignment, changed }
    })
  }

  appendContinuation(
    input: MissionRepository['appendContinuation'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      if (mission.state === 'cancelled') return null
      const id = shortId('assign')
      db.prepare(
        `INSERT INTO assignments
         (id, mission_id, worker_id, task, rationale, depends_on, review_required,
          state, requires, created_by_worker_id, dispatchable, workspace_path, stage_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        mission.id,
        input.workerId,
        input.task,
        input.rationale,
        serializeJson(input.dependsOn ?? []),
        0,
        'queued',
        serializeJson([]),
        'system:pipeline',
        1,
        null,
        input.stageKey ?? null,
      )
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'continuation',
          at: now(),
          workerId: input.workerId,
          assignmentId: id,
          message: `Queued continuation ${id} for ${input.workerId}`,
          data: {},
        },
        mission.id,
      )
      const updated = this.hydrateMission(db, mission.id)
      this.assertAcyclicDependencies(updated.assignments)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        mission.id,
      )
      return this.hydrateMission(db, mission.id)
    })
  }

  readyQueuedAssignments(missionId: string): Array<SwarmMissionAssignment> {
    const mission = this.getMission(missionId)
    if (!mission) return []
    const doneIds = new Set(
      mission.assignments
        .filter((item) => ['checkpointed', 'done'].includes(item.state))
        .map((item) => item.id),
    )
    return mission.assignments.filter(
      (item) =>
        item.state === 'queued' && item.dependsOn.every((id) => doneIds.has(id)),
    )
  }

  requeueAssignment(
    input: MissionRepository['requeueAssignment'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const assignment = mission.assignments.find((a) => a.id === input.assignmentId)
      if (!assignment) return null
      if (assignment.state !== 'dispatched') return mission
      db.prepare(
        'UPDATE assignments SET state = ?, dispatched_at = NULL WHERE id = ?',
      ).run('queued', assignment.id)
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'continuation',
          at: now(),
          assignmentId: assignment.id,
          message: `Requeued ${assignment.id}: ${input.reason}`,
          data: { reason: input.reason },
        },
        mission.id,
      )
      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        mission.id,
      )
      return this.hydrateMission(db, mission.id)
    })
  }

  requeueAssignmentForRework(
    input: MissionRepository['requeueAssignmentForRework'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const assignment = mission.assignments.find((a) => a.id === input.assignmentId)
      if (!assignment) return null
      if (
        ![
          'dispatched',
          'checkpointed',
          'done',
          'reviewing',
          'blocked',
          'needs_input',
        ].includes(assignment.state)
      )
        return mission
      db.prepare(
        `UPDATE assignments SET
          state = ?, dispatched_at = NULL, completed_at = NULL, checkpoint_json = NULL
         WHERE id = ?`,
      ).run('queued', assignment.id)
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'continuation',
          at: now(),
          assignmentId: assignment.id,
          message: `Requeued ${assignment.id} for rework: ${input.reason}`,
          data: { reason: input.reason },
        },
        mission.id,
      )
      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        mission.id,
      )
      return this.hydrateMission(db, mission.id)
    })
  }

  setAssignmentBaseRef(
    missionId: string,
    assignmentId: string,
    baseRef: string,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(missionId)
      if (!mission) return null
      const assignment = mission.assignments.find((a) => a.id === assignmentId)
      if (!assignment) return null
      db.prepare('UPDATE assignments SET base_ref = ? WHERE id = ?').run(
        baseRef,
        assignmentId,
      )
      db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(
        now(),
        missionId,
      )
      return this.hydrateMission(db, missionId)
    })
  }

  setAssignmentHeadSha(
    missionId: string,
    assignmentId: string,
    headSha: string,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(missionId)
      if (!mission) return null
      const assignment = mission.assignments.find((a) => a.id === assignmentId)
      if (!assignment) return null
      db.prepare('UPDATE assignments SET head_sha = ? WHERE id = ?').run(
        headSha,
        assignmentId,
      )
      db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(
        now(),
        missionId,
      )
      return this.hydrateMission(db, missionId)
    })
  }

  setMissionTaskId(input: {
    missionId: string
    taskId: string | null
  }): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      // task_id is deprecated; keep as JSON metadata for compatibility.
      db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(
        now(),
        input.missionId,
      )
      return this.hydrateMission(db, input.missionId)
    })
  }

  updateMissionRoomId(input: {
    missionId: string
    roomId: string | null
  }): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      db.prepare('UPDATE missions SET room_id = ?, updated_at = ? WHERE id = ?').run(
        input.roomId ?? null,
        now(),
        input.missionId,
      )
      return this.hydrateMission(db, input.missionId)
    })
  }

  patchMissionFields(
    input: MissionRepository['patchMissionFields'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const current = this.hydrateMission(db, input.missionId)
      let title = current.title
      if (input.title !== undefined) {
        const trimmed = input.title.trim()
        if (trimmed) title = trimmed
      }
      let spec = current.spec ?? ''
      let bumpSpecVersion = false
      if (input.spec !== undefined) {
        const next = String(input.spec)
        if (next !== spec) {
          spec = next
          bumpSpecVersion = true
        }
      }
      let acceptanceCriteria = current.acceptanceCriteria ?? []
      if (input.acceptanceCriteria !== undefined) {
        const next = input.acceptanceCriteria.map((c) => String(c))
        if (next.join('\0') !== acceptanceCriteria.join('\0')) {
          acceptanceCriteria = next
          bumpSpecVersion = true
        }
      }
      const assigneeType =
        input.assignee === undefined
          ? current.assignee?.type ?? null
          : input.assignee === null
            ? null
            : input.assignee.type
      const assigneeId =
        input.assignee === undefined
          ? current.assignee?.id ?? null
          : input.assignee === null
            ? null
            : input.assignee.id
      const boardLane =
        input.boardLane === undefined
          ? current.boardLane ?? null
          : input.boardLane === null
            ? null
            : input.boardLane

      db.prepare(
        `UPDATE missions SET
          title = ?, spec = ?, acceptance_criteria = ?,
          execution_mode = ?, assignee_type = ?, assignee_id = ?, room_id = ?,
          pipeline_id = ?, project_id = ?, priority = ?, labels = ?, board_lane = ?,
          spec_version = spec_version + ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        title,
        spec,
        serializeJson(acceptanceCriteria),
        input.executionMode === undefined
          ? current.executionMode ?? null
          : input.executionMode,
        assigneeType,
        assigneeId,
        input.roomId === undefined ? current.roomId ?? null : input.roomId,
        input.pipelineId === undefined
          ? current.pipelineId ?? null
          : input.pipelineId,
        input.projectId === undefined ? current.projectId ?? null : input.projectId,
        input.priority === undefined ? current.priority ?? null : input.priority,
        serializeJson(input.labels === undefined ? current.labels ?? [] : input.labels),
        boardLane,
        bumpSpecVersion ? 1 : 0,
        now(),
        input.missionId,
      )
      return this.hydrateMission(db, input.missionId)
    })
  }

  deleteMission(missionId: string): boolean {
    return this.withWriteSync((db) => {
      const result = db.prepare('DELETE FROM missions WHERE id = ?').run(missionId)
      return result.changes > 0
    })
  }

  rewriteAssignmentDependencies(
    input: MissionRepository['rewriteAssignmentDependencies'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      for (const assignment of mission.assignments) {
        const deps = input.dependsOnByAssignmentId[assignment.id]
        if (deps === undefined) continue
        db.prepare('UPDATE assignments SET depends_on = ? WHERE id = ?').run(
          serializeJson(deps),
          assignment.id,
        )
        if (input.stageKeyByAssignmentId?.[assignment.id] !== undefined) {
          db.prepare('UPDATE assignments SET stage_key = ? WHERE id = ?').run(
            input.stageKeyByAssignmentId[assignment.id],
            assignment.id,
          )
        }
        if (input.requiresByAssignmentId?.[assignment.id] !== undefined) {
          db.prepare('UPDATE assignments SET requires = ? WHERE id = ?').run(
            serializeJson(input.requiresByAssignmentId[assignment.id] ?? []),
            assignment.id,
          )
        }
        if (input.briefSpecVersion !== undefined) {
          db.prepare(
            'UPDATE assignments SET brief_spec_version = ? WHERE id = ?',
          ).run(input.briefSpecVersion, assignment.id)
        }
        if (input.createdByWorkerId !== undefined) {
          db.prepare(
            'UPDATE assignments SET created_by_worker_id = ? WHERE id = ?',
          ).run(input.createdByWorkerId, assignment.id)
        } else if (assignment.createdByWorkerId == null) {
          db.prepare(
            "UPDATE assignments SET created_by_worker_id = 'system:pipeline' WHERE id = ?",
          ).run(assignment.id)
        }
        db.prepare(
          'UPDATE assignments SET dispatchable = 1 WHERE dispatchable IS NULL',
        ).run()
      }
      if (input.pipelineId !== undefined) {
        db.prepare('UPDATE missions SET pipeline_id = ? WHERE id = ?').run(
          input.pipelineId,
          input.missionId,
        )
      }
      if (input.specVersion !== undefined) {
        db.prepare('UPDATE missions SET spec_version = ? WHERE id = ?').run(
          input.specVersion,
          input.missionId,
        )
      }
      if (input.executionMode !== undefined) {
        db.prepare('UPDATE missions SET execution_mode = ? WHERE id = ?').run(
          input.executionMode,
          input.missionId,
        )
      }
      const updated = this.hydrateMission(db, input.missionId)
      this.assertAcyclicDependencies(updated.assignments)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        input.missionId,
      )
      return this.hydrateMission(db, input.missionId)
    })
  }

  cancelAssignment(
    input: MissionRepository['cancelAssignment'] extends (arg: infer P) => unknown ? P : never,
  ): { mission: SwarmMission; assignment: SwarmMissionAssignment; changed: boolean } | null {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const assignment =
        (input.assignmentId
          ? mission.assignments.find((a) => a.id === input.assignmentId)
          : null) ??
        (input.workerId
          ? [...mission.assignments]
              .reverse()
              .find(
                (item) =>
                  item.workerId === input.workerId && !isTerminal(item),
              )
          : null) ??
        null
      if (!assignment) return null
      if (assignment.state === 'cancelled')
        return { mission, assignment, changed: false }
      const cancelledAt = now()
      db.prepare(
        `UPDATE assignments SET
          state = 'cancelled', completed_at = ?, reviewed_at = ?, reviewed_by = ?
         WHERE id = ?`,
      ).run(
        cancelledAt,
        cancelledAt,
        input.actor?.trim() || 'system-cancel',
        assignment.id,
      )
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'assignment_cancelled',
          at: cancelledAt,
          workerId: assignment.workerId,
          assignmentId: assignment.id,
          message: `Cancelled ${assignment.id}${input.reason ? `: ${input.reason}` : ''}`,
          data: {
            actor: input.actor?.trim() || 'system-cancel',
            reason: input.reason?.trim() || null,
          },
        },
        mission.id,
      )
      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        cancelledAt,
        mission.id,
      )
      const final = this.hydrateMission(db, mission.id)
      return { mission: final, assignment: { ...assignment, state: 'cancelled' }, changed: true }
    })
  }

  appendOrchestratorEvent(
    input: MissionRepository['appendOrchestratorEvent'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'continuation',
          at: now(),
          message: input.message,
          data: { source: 'langgraph-orchestrator', ...(input.data ?? {}) },
        },
        input.missionId,
      )
      db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(
        now(),
        input.missionId,
      )
      return this.hydrateMission(db, input.missionId)
    })
  }

  cancelMission(
    input: MissionRepository['cancelMission'] extends (arg: infer P) => unknown ? P : never,
  ): { mission: SwarmMission; cancelledAssignmentIds: Array<string>; changed: boolean } | null {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const cancelledAt = now()
      const cancelledAssignmentIds: Array<string> = []
      for (const assignment of mission.assignments) {
        if (isTerminal(assignment)) continue
        db.prepare(
          `UPDATE assignments SET
            state = 'cancelled', completed_at = ?, reviewed_at = ?, reviewed_by = ?
           WHERE id = ?`,
        ).run(
          cancelledAt,
          cancelledAt,
          input.actor?.trim() || 'system-cancel',
          assignment.id,
        )
        cancelledAssignmentIds.push(assignment.id)
      }
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'mission_cancelled',
          at: cancelledAt,
          message: `Cancelled mission${input.reason ? `: ${input.reason}` : ''}`,
          data: {
            actor: input.actor?.trim() || 'system-cancel',
            reason: input.reason?.trim() || null,
            cancelledAssignmentIds,
          },
        },
        mission.id,
      )
      db.prepare(
        "UPDATE missions SET state = 'cancelled', updated_at = ? WHERE id = ?",
      ).run(cancelledAt, mission.id)
      return {
        mission: this.hydrateMission(db, mission.id),
        cancelledAssignmentIds,
        changed: cancelledAssignmentIds.length > 0,
      }
    })
  }

  markAssignmentReviewed(
    input: MissionRepository['markAssignmentReviewed'] extends (arg: infer P) => unknown ? P : never,
  ): SwarmMission | null {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const assignment = mission.assignments.find(
        (item) => item.id === input.assignmentId,
      )
      if (!assignment) return null
      db.prepare(
        `UPDATE assignments SET
          state = 'done', reviewed_at = ?, reviewed_by = ?
         WHERE id = ?`,
      ).run(now(), input.reviewerId ?? null, assignment.id)
      this.persistEvent(
        db,
        {
          id: shortId('evt'),
          type: 'review',
          at: now(),
          workerId: input.reviewerId,
          assignmentId: assignment.id,
          message: `Reviewed ${assignment.id}${input.reviewerId ? ` by ${input.reviewerId}` : ''}`,
        },
        mission.id,
      )
      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        now(),
        mission.id,
      )
      return this.hydrateMission(db, mission.id)
    })
  }

  markAssignmentsReviewedByWorker(
    input: MissionRepository['markAssignmentsReviewedByWorker'] extends (arg: infer P) => unknown ? P : never,
  ): { mission: SwarmMission; reviewedAssignmentIds: Array<string> } | null {
    return this.withWriteSync((db) => {
      if (!input.missionId) return null
      const mission = this.getMission(input.missionId)
      if (!mission) return null
      const reviewedAt = now()
      const reviewed = mission.assignments.filter(
        (assignment) =>
          assignment.id !== input.excludeAssignmentId &&
          assignment.workerId !== input.reviewerId &&
          assignment.reviewRequired &&
          assignment.state === 'checkpointed',
      )
      if (reviewed.length === 0) return { mission, reviewedAssignmentIds: [] }
      for (const assignment of reviewed) {
        db.prepare(
          `UPDATE assignments SET
            state = 'done', reviewed_at = ?, reviewed_by = ?
           WHERE id = ?`,
        ).run(reviewedAt, input.reviewerId, assignment.id)
        this.persistEvent(
          db,
          {
            id: shortId('evt'),
            type: 'review',
            at: reviewedAt,
            workerId: input.reviewerId,
            assignmentId: assignment.id,
            message: `Reviewed ${assignment.id} by ${input.reviewerId}`,
          },
          mission.id,
        )
      }
      const updated = this.hydrateMission(db, mission.id)
      updated.state = deriveMissionStatus(updated.assignments)
      db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
        updated.state,
        reviewedAt,
        mission.id,
      )
      return {
        mission: this.hydrateMission(db, mission.id),
        reviewedAssignmentIds: reviewed.map((assignment) => assignment.id),
      }
    })
  }

  listReports(input?: {
    missionId?: string | null
    workerId?: string | null
    limit?: number
  }): Array<SwarmCheckpointReport> {
    const limit = Math.max(1, Math.min(500, input?.limit ?? 100))
    const db = this.dbReadonly()
    try {
      let sql = `SELECT mission_id, assignment_id, worker_id, data_json, at
                 FROM mission_events
                 WHERE type = 'checkpoint'`
      const params: Array<unknown> = []
      if (input?.missionId) {
        sql += ' AND mission_id = ?'
        params.push(input.missionId)
      }
      sql += ' ORDER BY at DESC LIMIT ?'
      params.push(limit)
      const rows = db.prepare(sql).all(...params) as Array<{
        mission_id: string
        assignment_id: string
        worker_id: string
        data_json: string
        at: number
      }>
      return rows
        .map((row) => {
          const data = parseJson<Record<string, unknown>>(row.data_json, {})
          return {
            missionId: row.mission_id,
            assignmentId: row.assignment_id,
            workerId: row.worker_id,
            recordedAt: row.at,
            stateLabel: String(data.stateLabel ?? ''),
            checkpointStatus: String(data.checkpointStatus ?? ''),
            runtimeState: String(data.runtimeState ?? ''),
            filesChanged: data.filesChanged == null ? null : String(data.filesChanged),
            commandsRun: data.commandsRun == null ? null : String(data.commandsRun),
            result: data.result == null ? null : String(data.result),
            blocker: data.blocker == null ? null : String(data.blocker),
            nextAction: data.nextAction == null ? null : String(data.nextAction),
            source: String(data.source ?? 'unknown'),
          } as SwarmCheckpointReport
        })
        .filter(
          (report) =>
            !input?.workerId || report.workerId === input.workerId,
        )
        .slice(0, limit)
    } finally {
      db.close()
    }
  }

  archiveStaleMissions(staleMs = 6 * 60 * 60 * 1000): {
    archivedIds: Array<string>
    count: number
  } {
    return this.withWriteSync((db) => {
      const cutoff = Date.now() - staleMs
      const rows = db
        .prepare(
          `SELECT id FROM missions
           WHERE state NOT IN ('running','todo','ready')
             AND updated_at < ?`,
        )
        .all(cutoff) as Array<{ id: string }>
      const archivedIds: Array<string> = []
      for (const row of rows) {
        const mission = this.hydrateMission(db, row.id)
        if (
          mission.assignments.every((a) =>
            ['done', 'checkpointed', 'blocked', 'needs_input'].includes(a.state),
          )
        ) {
          db.prepare("UPDATE missions SET state = 'done', updated_at = ? WHERE id = ?").run(
            now(),
            row.id,
          )
          this.persistEvent(
            db,
            {
              id: shortId('evt'),
              type: 'continuation',
              at: now(),
              message: `Archived as stale (>${Math.round(staleMs / 3600000)}h, all assignments terminal)`,
            },
            row.id,
          )
          archivedIds.push(row.id)
        }
      }
      return { archivedIds, count: archivedIds.length }
    })
  }

  exportToJson(): Array<SwarmMission> {
    return this.listMissions(1000)
  }

  private assertAcyclicDependencies(
    assignments: Array<SwarmMissionAssignment>,
  ): void {
    const ids = new Set(assignments.map((a) => a.id))
    const indegree = new Map<string, number>()
    const edges = new Map<string, Array<string>>()
    for (const a of assignments) {
      indegree.set(a.id, 0)
    }
    for (const a of assignments) {
      for (const dep of a.dependsOn) {
        if (!ids.has(dep)) continue
        indegree.set(a.id, (indegree.get(a.id) ?? 0) + 1)
        const list = edges.get(dep) ?? []
        list.push(a.id)
        edges.set(dep, list)
      }
    }
    const queue = assignments
      .filter((a) => (indegree.get(a.id) ?? 0) === 0)
      .map((a) => a.id)
    let visited = 0
    while (queue.length > 0) {
      const current = queue.pop()!
      visited++
      for (const next of edges.get(current) ?? []) {
        const remaining = (indegree.get(next) ?? 0) - 1
        indegree.set(next, remaining)
        if (remaining === 0) queue.push(next)
      }
    }
    if (visited < ids.size) {
      const cyclic = assignments
        .filter((a) => (indegree.get(a.id) ?? 0) > 0)
        .map((a) => a.id)
      throw new Error(
        `dependsOn cycle detected among assignments: ${cyclic.join(', ')}`,
      )
    }
  }
}

