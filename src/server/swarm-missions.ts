import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { SWARM_CANONICAL_REPO, SWARM_MISSIONS_PATH } from './swarm-environment'
export { SWARM_MISSIONS_PATH }
import { applyArtifactPathPolicy } from './swarm-mission-artifacts'
import type { ParsedSwarmCheckpoint } from './swarm-checkpoints'
import {
  deriveMissionStatus,
  normalizeMissionStatus,
  type MissionStatus,
} from './task-pipeline/mission-status'
import {
  SWARM_MISSION_ASSIGNMENT_STATES,
  TERMINAL_ASSIGNMENT_STATES,
  type SwarmMissionAssignmentState,
  isSwarmMissionAssignmentState,
} from './schema'
import {
  type MissionRepository,
  SqliteMissionRepository,
} from './task-pipeline/mission-repository'
import {
  fireCheckpointReviewHook,
  fireCheckpointTerminalHook,
  setOnCheckpointReviewHook,
  setOnCheckpointTerminalHook,
} from './task-pipeline/mission-hooks'

export type { SwarmMissionAssignmentState }
export {
  SWARM_MISSION_ASSIGNMENT_STATES,
  TERMINAL_ASSIGNMENT_STATES,
  isSwarmMissionAssignmentState,
}

/** Multica-style: mission.state === board column. */
export type SwarmMissionState = MissionStatus

export type MissionExecutionMode = 'pipeline' | 'assignee'

export type MissionAssignee = {
  type: 'agent' | 'chat_group'
  id: string
}

/** Optional external tracker / Symphony Issue identity (hangs on Task). */
export type TaskExternalRef = {
  kind: string
  id: string
  identifier?: string
  url?: string
}

export type SwarmMissionAssignment = {
  id: string
  workerId: string
  task: string
  rationale: string | null
  dependsOn: Array<string>
  reviewRequired: boolean
  state: SwarmMissionAssignmentState
  dispatchedAt: number | null
  completedAt: number | null
  reviewedAt: number | null
  reviewedBy: string | null
  checkpoint: ParsedSwarmCheckpoint | null
  /** Pipeline stage key this assignment was created from (P2a task module). */
  stageKey?: string | null
  /** specVersion the instruction text was generated against (stale check). */
  briefSpecVersion?: number | null
  /** Git refs for this assignment's commit range (P2b). */
  baseRef?: string | null
  headSha?: string | null
  /** Capability requirements for this stage (P2b). */
  requires?: Array<string>
  /** Who decomposed/dispatched this task (e.g. system:pipeline, orchestrator). */
  createdByWorkerId?: string | null
  /** Symphony-aligned: eligibility for automated dispatch. */
  dispatchable?: boolean
  /** Symphony-aligned: optional tracker / external issue ref. */
  externalRef?: TaskExternalRef | null
  /** Symphony-aligned: per-task workspace path snapshot. */
  workspacePath?: string | null
}

export type SwarmMission = {
  id: string
  title: string
  state: SwarmMissionState
  createdAt: number
  updatedAt: number
  assignments: Array<SwarmMissionAssignment>
  events: Array<SwarmMissionEvent>
  /** User-authored mission description (may include workspace path refs). */
  spec?: string
  /** Acceptance criteria lines persisted for edit / redisplay. */
  acceptanceCriteria?: Array<string>
  /** Bumped on every spec edit; stale brief detection compares against this. */
  specVersion?: number
  /** Pipeline template this mission was instantiated from (P2a). */
  pipelineId?: string | null
  /** @deprecated Unused; Mission list is mission-keyed. Prefer null. */
  taskId?: string | null
  /** Project this mission targets (P2b). */
  projectId?: string | null
  /** workspaceMode: canonical | worktree (P2b). */
  workspaceMode?: string | null
  /** How this mission was created: pipeline template vs direct assignee. */
  executionMode?: MissionExecutionMode | null
  /** Mission-level assignee (agent or chat group); null in pipeline mode. */
  assignee?: MissionAssignee | null
  /**
   * Bound group-chat room. Null by default for pipeline missions;
   * set when user manually creates a room or assignee is chat_group.
   */
  roomId?: string | null
  /** Optional display helpers for MissionSurface filters. */
  priority?: number | null
  labels?: Array<string>
  /**
   * Optional human board pin (MissionSurface drag).
   * When set, UI column uses this; otherwise `state` (derived from tasks).
   */
  boardLane?: SwarmMissionState | null
}

export type SwarmMissionEvent = {
  id: string
  type:
    | 'created'
    | 'assignment_dispatched'
    | 'checkpoint'
    | 'continuation'
    | 'review'
    | 'blocked'
    | 'assignment_cancelled'
    | 'mission_cancelled'
  at: number
  workerId?: string
  assignmentId?: string
  message: string
  data?: Record<string, unknown>
}

export type SwarmCheckpointReport = {
  missionId: string
  assignmentId: string
  workerId: string
  recordedAt: number
  stateLabel: ParsedSwarmCheckpoint['stateLabel']
  checkpointStatus: ParsedSwarmCheckpoint['checkpointStatus']
  runtimeState: ParsedSwarmCheckpoint['runtimeState']
  filesChanged: string | null
  commandsRun: string | null
  result: string | null
  blocker: string | null
  nextAction: string | null
  source: string
}

type SwarmMissionStore = {
  version: 1
  missions: Array<SwarmMission>
}

function now(): number {
  return Date.now()
}

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readStore(): SwarmMissionStore {
  if (!existsSync(SWARM_MISSIONS_PATH)) return { version: 1, missions: [] }
  try {
    const parsed = JSON.parse(
      readFileSync(SWARM_MISSIONS_PATH, 'utf8'),
    ) as SwarmMissionStore
    const missions = Array.isArray(parsed.missions) ? parsed.missions : []
    return {
      version: 1,
      missions: missions.map((mission) => ({
        ...mission,
        state: normalizeMissionStatus(mission.state),
        boardLane:
          mission.boardLane == null
            ? mission.boardLane
            : normalizeMissionStatus(mission.boardLane),
      })),
    }
  } catch {
    return { version: 1, missions: [] }
  }
}

function writeStore(store: SwarmMissionStore): void {
  mkdirSync(dirname(SWARM_MISSIONS_PATH), { recursive: true })
  const tmp = `${SWARM_MISSIONS_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
  renameSync(tmp, SWARM_MISSIONS_PATH)
}

function event(
  type: SwarmMissionEvent['type'],
  message: string,
  extra?: Partial<SwarmMissionEvent>,
): SwarmMissionEvent {
  return { id: shortId('evt'), type, at: now(), message, ...extra }
}

function reportFromCheckpoint(input: {
  missionId: string
  assignmentId: string
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): SwarmCheckpointReport {
  return {
    missionId: input.missionId,
    assignmentId: input.assignmentId,
    workerId: input.workerId,
    recordedAt: now(),
    stateLabel: input.checkpoint.stateLabel,
    checkpointStatus: input.checkpoint.checkpointStatus,
    runtimeState: input.checkpoint.runtimeState,
    filesChanged: input.checkpoint.filesChanged,
    commandsRun: input.checkpoint.commandsRun,
    result: input.checkpoint.result,
    blocker: input.checkpoint.blocker,
    nextAction: input.checkpoint.nextAction,
    source: input.source?.trim() || 'unknown',
  }
}

function deriveMissionState(
  assignments: Array<SwarmMissionAssignment>,
): SwarmMissionState {
  return deriveMissionStatus(assignments)
}

function inferReviewRequired(task: string, rationale?: string | null): boolean {
  // Match intent-bearing task terms only. The previous loose alternation matched
  // substrings such as "patch" inside "dispatch" and left simple smoke runs in
  // review forever.
  return /\b(code|patch(?:es|ed|ing)?|implement(?:ation|ed|ing)?|pr|benchmarks?)\b/i.test(
    `${task} ${rationale ?? ''}`,
  )
}

const terminalAssignmentStateSet = new Set<string>(
  TERMINAL_ASSIGNMENT_STATES,
)

function isTerminalAssignment(assignment: SwarmMissionAssignment): boolean {
  return terminalAssignmentStateSet.has(assignment.state)
}

function _legacylistSwarmMissions(limit = 20): Array<SwarmMission> {
  return readStore()
    .missions.sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
}

function _legacygetSwarmMission(missionId: string): SwarmMission | null {
  return (
    readStore().missions.find((mission) => mission.id === missionId) ?? null
  )
}

function _legacyarchiveStaleMissions(staleMs: number = 6 * 60 * 60 * 1000): {
  archivedIds: Array<string>
  count: number
} {
  const store = readStore()
  const now = Date.now()
  const archivedIds: Array<string> = []
  for (const mission of store.missions) {
    if (
      mission.state !== 'running' &&
      mission.state !== 'todo' &&
      mission.state !== 'ready'
    )
      continue
    if (now - mission.updatedAt < staleMs) continue
    if (
      !mission.assignments.every((a) =>
        ['done', 'checkpointed', 'blocked', 'needs_input'].includes(a.state),
      )
    )
      continue
    mission.state = 'done'
    mission.events.push(
      event(
        'continuation',
        `Archived as stale (>${Math.round(staleMs / 3600000)}h, all assignments terminal)`,
      ),
    )
    archivedIds.push(mission.id)
  }
  if (archivedIds.length) {
    writeStore(store)
  }
  return { archivedIds, count: archivedIds.length }
}

export type CreateOrUpdateMissionResult = SwarmMission & { _created?: boolean }

/**
 * Kahn topological check on the assignment dependsOn graph. Throws with the
 * offending cycle members when a cycle exists. Edges pointing at unknown
 * ids are ignored here (they simply never satisfy) — only true cycles
 * deadlock the pipeline.
 */
export function assertAcyclicDependencies(
  assignments: Array<SwarmMissionAssignment>,
): void {
  const ids = new Set(assignments.map((a) => a.id))
  const indegree = new Map<string, number>()
  const edges = new Map<string, Array<string>>() // dep → dependents
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

function _legacycreateOrUpdateMission(input: {
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
}): CreateOrUpdateMissionResult {
  const store = readStore()
  const createdAt = now()
  const missionId = input.missionId?.trim() || shortId('mission')
  let mission = store.missions.find((item) => item.id === missionId)
  let createdMission = false
  if (!mission) {
    mission = {
      id: missionId,
      title: input.title || 'Untitled swarm mission',
      state: 'todo',
      createdAt,
      updatedAt: createdAt,
      assignments: [],
      events: [
        event('created', `Mission created: ${input.title || missionId}`),
      ],
      spec: input.spec ?? '',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      specVersion: 1,
      projectId: input.projectId ?? null,
      workspaceMode: input.workspaceMode ?? null,
      executionMode: input.executionMode ?? null,
      assignee: input.assignee ?? null,
      roomId: input.roomId ?? null,
      pipelineId: input.pipelineId ?? null,
      priority: input.priority ?? null,
      labels: input.labels ?? [],
    }
    store.missions.push(mission)
    createdMission = true
  }

  mission.title = input.title || mission.title
  if (input.spec !== undefined) mission.spec = input.spec
  if (input.acceptanceCriteria !== undefined) {
    mission.acceptanceCriteria = input.acceptanceCriteria
  }
  if (input.projectId !== undefined) mission.projectId = input.projectId
  if (input.workspaceMode !== undefined)
    mission.workspaceMode = input.workspaceMode
  if (input.executionMode !== undefined)
    mission.executionMode = input.executionMode
  if (input.assignee !== undefined) mission.assignee = input.assignee
  if (input.roomId !== undefined) mission.roomId = input.roomId
  if (input.pipelineId !== undefined) mission.pipelineId = input.pipelineId
  if (input.priority !== undefined) mission.priority = input.priority
  if (input.labels !== undefined) mission.labels = input.labels
  if (createdMission && mission.specVersion == null) mission.specVersion = 1
  for (const assignment of input.assignments) {
    // One active assignment per worker per mission. Skip if the worker already
    // has a non-terminal assignment, regardless of task text differences.
    const existing = mission.assignments.find(
      (item) =>
        item.workerId === assignment.workerId && !isTerminalAssignment(item),
    )
    if (existing) continue
    const id = shortId('assign')
    mission.assignments.push({
      id,
      workerId: assignment.workerId,
      task: assignment.task,
      rationale: assignment.rationale ?? null,
      dependsOn: assignment.dependsOn ?? [],
      reviewRequired:
        assignment.reviewRequired ??
        inferReviewRequired(assignment.task, assignment.rationale),
      state: 'queued',
      requires: assignment.requires ?? [],
      dispatchedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      checkpoint: null,
      createdByWorkerId: assignment.createdByWorkerId ?? 'system:pipeline',
      dispatchable: assignment.dispatchable !== false,
      externalRef: assignment.externalRef ?? null,
      workspacePath: assignment.workspacePath ?? null,
      stageKey: assignment.stageKey ?? null,
    })
  }
  // Cycle guard (plan risk table): a cyclic dependsOn graph makes
  // _legacyreadyQueuedAssignments return [] forever — the pipeline silently dies.
  // Reject at registration time, where the error is loud and attributable.
  assertAcyclicDependencies(mission.assignments)
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return Object.assign(mission, { _created: createdMission })
}

function _legacymarkMissionAssignmentDispatched(input: {
  missionId: string
  workerId: string
  task: string
  assignmentId?: string
  source?: string | null
  author?: string | null
  /** Override the assignment's workerId (e.g. capability routing chose a different agent). */
  overrideWorkerId?: string
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'done')
    return mission
  const assignment = input.assignmentId
    ? mission.assignments.find((item) => item.id === input.assignmentId)
    : mission.assignments.find(
        (item) => item.workerId === input.workerId && item.task === input.task,
      )
  if (!assignment) return null
  if (isTerminalAssignment(assignment)) return mission
  assignment.state = 'dispatched'
  assignment.dispatchedAt = now()
  if (input.overrideWorkerId) {
    assignment.workerId = input.overrideWorkerId
  }
  // Clearing any stale checkpoint from a previous dispatch prevents the
  // harvester from confusing the old result with output from this new run.
  assignment.checkpoint = null
  assignment.completedAt = null
  mission.events.push(
    event(
      'assignment_dispatched',
      `Dispatched ${assignment.id} to ${input.workerId}`,
      {
        workerId: input.workerId,
        assignmentId: assignment.id,
        data: {
          task: assignment.task,
          source: input.source?.trim() || 'swarm-dispatch',
          author: input.author?.trim() || 'aurora',
        },
      },
    ),
  )
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

export type RecordCheckpointResult =
  | (SwarmMission & { _completed?: boolean; _ignoredReason?: string })
  | null

export {
  setOnCheckpointTerminalHook,
  setOnCheckpointReviewHook,
}

function _legacyRecordMissionCheckpoint(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  checkpoint: ParsedSwarmCheckpoint
  source?: string | null
}): RecordCheckpointResult {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled')
    return Object.assign(mission, { _ignoredReason: 'mission cancelled' })
  const assignment =
    (input.assignmentId
      ? mission.assignments.find((item) => item.id === input.assignmentId)
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
  if (assignment.checkpoint?.raw === input.checkpoint.raw) {
    return Object.assign(mission, { _completed: mission.state === 'done' })
  }
  const checkpoint = applyArtifactPathPolicy(
    input.checkpoint,
    input.missionId,
    input.workerId,
  )
  assignment.checkpoint = checkpoint
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
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint,
    source: input.source,
  })
  mission.events.push(
    event(
      'checkpoint',
      `${input.workerId} checkpointed: ${checkpoint.stateLabel}`,
      {
        workerId: input.workerId,
        assignmentId: assignment.id,
        data: report,
      },
    ),
  )
  mission.updatedAt = now()
  const previousState = mission.state
  mission.state = deriveMissionState(mission.assignments)
  const completed = mission.state === 'done' && previousState !== 'done'
  writeStore(store)

  // Swarm-path orchestration hooks. MCP callers (source === 'mcp') handle
  // review verdict and next-stage dispatch in advance.ts; firing these hooks
  // for them would double-process the checkpoint.
  if (checkpoint.reviewOutcome) {
    fireCheckpointReviewHook(
      mission.id,
      assignment.id,
      input.workerId,
      checkpoint,
      input.source,
    )
  }
  if (isTerminalAssignment(assignment)) {
    fireCheckpointTerminalHook(
      mission.id,
      assignment.id,
      input.workerId,
      checkpoint,
      input.source,
    )
  }

  return Object.assign(mission, { _completed: completed })
}

function _legacyrecordMissionAssignmentBlocked(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId: string
  reason?: string | null
  source?: string | null
}): {
  mission: SwarmMission
  assignment: SwarmMissionAssignment
  changed: boolean
} | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled' || mission.state === 'done') return null
  const assignment =
    (input.assignmentId
      ? mission.assignments.find((item) => item.id === input.assignmentId)
      : null) ??
    [...mission.assignments]
      .reverse()
      .find(
        (item) =>
          item.workerId === input.workerId && !isTerminalAssignment(item),
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
    assignment.state !== 'blocked' ||
    assignment.checkpoint?.raw !== checkpoint.raw
  assignment.state = 'blocked'
  assignment.completedAt = blockedAt
  assignment.checkpoint = checkpoint
  const report = reportFromCheckpoint({
    missionId: mission.id,
    assignmentId: assignment.id,
    workerId: input.workerId,
    checkpoint,
    source: input.source,
  })
  if (changed) {
    mission.events.push(
      event('blocked', `${input.workerId} blocked: ${reason}`, {
        workerId: input.workerId,
        assignmentId: assignment.id,
        data: report,
      }),
    )
  }
  mission.updatedAt = blockedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed }
}

function _legacyappendMissionContinuation(input: {
  missionId?: string | null
  workerId: string
  task: string
  rationale: string
  dependsOn?: Array<string>
  stageKey?: string | null
}): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (mission.state === 'cancelled') return null
  const id = shortId('assign')
  mission.assignments.push({
    id,
    workerId: input.workerId,
    task: input.task,
    rationale: input.rationale,
    dependsOn: input.dependsOn ?? [],
    reviewRequired: false,
    state: 'queued',
    dispatchedAt: null,
    completedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    checkpoint: null,
    createdByWorkerId: 'system:pipeline',
    dispatchable: true,
    externalRef: null,
    workspacePath: null,
    stageKey: input.stageKey ?? null,
  })
  assertAcyclicDependencies(mission.assignments)
  mission.events.push(
    event('continuation', `Queued continuation ${id} for ${input.workerId}`, {
      workerId: input.workerId,
      assignmentId: id,
    }),
  )
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

function _legacyreadyQueuedAssignments(
  missionId: string,
): Array<SwarmMissionAssignment> {
  const mission = _legacygetSwarmMission(missionId)
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

function _legacyrequeueMissionAssignment(input: {
  missionId: string
  assignmentId: string
  reason: string
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find(
    (item) => item.id === input.assignmentId,
  )
  if (!assignment) return null
  if (assignment.state !== 'dispatched') return mission
  assignment.state = 'queued'
  assignment.dispatchedAt = null
  mission.events.push(
    event('continuation', `Requeued ${assignment.id}: ${input.reason}`, {
      assignmentId: assignment.id,
      data: { reason: input.reason },
    }),
  )
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

/**
 * Requeue a terminal assignment for rework. Unlike _legacyrequeueMissionAssignment,
 * this works on checkpointed/done/reviewing assignments and clears their
 * checkpoint so the next dispatch starts fresh.
 */
function _legacyrequeueAssignmentForRework(input: {
  missionId: string
  assignmentId: string
  reason: string
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find(
    (item) => item.id === input.assignmentId,
  )
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
  assignment.state = 'queued'
  assignment.dispatchedAt = null
  assignment.completedAt = null
  assignment.checkpoint = null
  mission.events.push(
    event(
      'continuation',
      `Requeued ${assignment.id} for rework: ${input.reason}`,
      {
        assignmentId: assignment.id,
        data: { reason: input.reason },
      },
    ),
  )
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

/**
 * P2a two-pass instantiation helper: after all stage assignments exist,
 * rewrite their dependsOn from stage keys to assignment ids, stamp
 * stageKey / briefSpecVersion, and bind the mission to its pipeline + card.
 * Re-runs the cycle guard after rewiring. Single write, one place for the
 * invariant.
 */
function _legacysetAssignmentBaseRef(
  missionId: string,
  assignmentId: string,
  baseRef: string,
): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((m) => m.id === missionId)
  if (!mission) return null
  const assignment = mission.assignments.find((a) => a.id === assignmentId)
  if (!assignment) return null
  assignment.baseRef = baseRef
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

function _legacysetAssignmentHeadSha(
  missionId: string,
  assignmentId: string,
  headSha: string,
): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((m) => m.id === missionId)
  if (!mission) return null
  const assignment = mission.assignments.find((a) => a.id === assignmentId)
  if (!assignment) return null
  assignment.headSha = headSha
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

function _legacysetMissionTaskId(input: {
  missionId: string
  taskId: string | null
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  mission.taskId = input.taskId
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

function _legacyupdateMissionRoomId(input: {
  missionId: string
  roomId: string | null
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  mission.roomId = input.roomId
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

function _legacypatchMissionFields(input: {
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
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  if (input.title !== undefined) {
    const trimmed = input.title.trim()
    if (trimmed) mission.title = trimmed
  }
  let bumpSpecVersion = false
  if (input.spec !== undefined) {
    const next = String(input.spec)
    if (next !== (mission.spec ?? '')) {
      mission.spec = next
      bumpSpecVersion = true
    }
  }
  if (input.acceptanceCriteria !== undefined) {
    const next = input.acceptanceCriteria.map((c) => String(c))
    const prev = mission.acceptanceCriteria ?? []
    if (next.join('\0') !== prev.join('\0')) {
      mission.acceptanceCriteria = next
      bumpSpecVersion = true
    }
  }
  if (bumpSpecVersion) {
    mission.specVersion = (mission.specVersion ?? 0) + 1
  }
  if (input.executionMode !== undefined)
    mission.executionMode = input.executionMode
  if (input.assignee !== undefined) mission.assignee = input.assignee
  if (input.roomId !== undefined) mission.roomId = input.roomId
  if (input.pipelineId !== undefined) mission.pipelineId = input.pipelineId
  if (input.projectId !== undefined) mission.projectId = input.projectId
  if (input.priority !== undefined) mission.priority = input.priority
  if (input.labels !== undefined) mission.labels = input.labels
  if (input.boardLane !== undefined) {
    mission.boardLane =
      input.boardLane === null
        ? null
        : normalizeMissionStatus(input.boardLane)
  }
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

/** Hard-delete a mission from the swarm store. Returns false if missing. */
function _legacydeleteSwarmMission(missionId: string): boolean {
  const store = readStore()
  const next = store.missions.filter((item) => item.id !== missionId)
  if (next.length === store.missions.length) return false
  writeStore({ ...store, missions: next })
  return true
}

function _legacyrewriteAssignmentDependencies(input: {
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
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  for (const assignment of mission.assignments) {
    const deps = input.dependsOnByAssignmentId[assignment.id]
    // dependsOnByAssignmentId is a full map over every stage assignment built
    // by the caller (instantiatePipeline); a missing key means caller bug.
    assignment.dependsOn = deps
    const stageKey = input.stageKeyByAssignmentId?.[assignment.id]
    if (stageKey !== undefined) assignment.stageKey = stageKey
    const requires = input.requiresByAssignmentId?.[assignment.id]
    if (requires !== undefined) assignment.requires = requires
    if (input.briefSpecVersion !== undefined)
      assignment.briefSpecVersion = input.briefSpecVersion
    if (input.createdByWorkerId !== undefined) {
      assignment.createdByWorkerId = input.createdByWorkerId
    } else if (assignment.createdByWorkerId == null) {
      assignment.createdByWorkerId = 'system:pipeline'
    }
    if (assignment.dispatchable === undefined) assignment.dispatchable = true
  }
  if (input.pipelineId !== undefined) mission.pipelineId = input.pipelineId
  if (input.taskId !== undefined) mission.taskId = input.taskId
  if (input.specVersion !== undefined) mission.specVersion = input.specVersion
  if (input.executionMode !== undefined)
    mission.executionMode = input.executionMode
  assertAcyclicDependencies(mission.assignments)
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

function _legacycancelSwarmAssignment(input: {
  missionId?: string | null
  assignmentId?: string | null
  workerId?: string | null
  actor?: string | null
  reason?: string | null
}): {
  mission: SwarmMission
  assignment: SwarmMissionAssignment
  changed: boolean
} | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment =
    (input.assignmentId
      ? mission.assignments.find((item) => item.id === input.assignmentId)
      : null) ??
    (input.workerId
      ? [...mission.assignments]
          .reverse()
          .find(
            (item) =>
              item.workerId === input.workerId && !isTerminalAssignment(item),
          )
      : null) ??
    null
  if (!assignment) return null
  if (assignment.state === 'cancelled')
    return { mission, assignment, changed: false }
  const cancelledAt = now()
  assignment.state = 'cancelled'
  assignment.completedAt = cancelledAt
  assignment.reviewedAt = cancelledAt
  assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
  mission.events.push(
    event(
      'assignment_cancelled',
      `Cancelled ${assignment.id}${input.reason ? `: ${input.reason}` : ''}`,
      {
        workerId: assignment.workerId,
        assignmentId: assignment.id,
        data: {
          actor: input.actor?.trim() || 'system-cancel',
          reason: input.reason?.trim() || null,
        },
      },
    ),
  )
  mission.updatedAt = cancelledAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return { mission, assignment, changed: true }
}

function _legacyappendSwarmMissionOrchestratorEvent(input: {
  missionId: string
  message: string
  data?: Record<string, unknown>
}): SwarmMission | null {
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  mission.events.push(
    event('continuation', input.message, {
      data: {
        source: 'langgraph-orchestrator',
        ...(input.data ?? {}),
      },
    }),
  )
  mission.updatedAt = now()
  writeStore(store)
  return mission
}

function _legacycancelSwarmMission(input: {
  missionId?: string | null
  actor?: string | null
  reason?: string | null
}): {
  mission: SwarmMission
  cancelledAssignmentIds: Array<string>
  changed: boolean
} | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const cancelledAt = now()
  const cancelledAssignmentIds: Array<string> = []
  for (const assignment of mission.assignments) {
    if (isTerminalAssignment(assignment)) continue
    assignment.state = 'cancelled'
    assignment.completedAt = cancelledAt
    assignment.reviewedAt = cancelledAt
    assignment.reviewedBy = input.actor?.trim() || 'system-cancel'
    cancelledAssignmentIds.push(assignment.id)
  }
  mission.state = 'cancelled'
  mission.updatedAt = cancelledAt
  mission.events.push(
    event(
      'mission_cancelled',
      `Cancelled mission${input.reason ? `: ${input.reason}` : ''}`,
      {
        data: {
          actor: input.actor?.trim() || 'system-cancel',
          reason: input.reason?.trim() || null,
          cancelledAssignmentIds,
        },
      },
    ),
  )
  writeStore(store)
  return {
    mission,
    cancelledAssignmentIds,
    changed: cancelledAssignmentIds.length > 0,
  }
}

function _legacymarkMissionAssignmentReviewed(input: {
  missionId?: string | null
  assignmentId: string
  reviewerId?: string
}): SwarmMission | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
  if (!mission) return null
  const assignment = mission.assignments.find(
    (item) => item.id === input.assignmentId,
  )
  if (!assignment) return null
  assignment.state = 'done'
  assignment.reviewedAt = now()
  assignment.reviewedBy = input.reviewerId ?? null
  mission.events.push(
    event(
      'review',
      `Reviewed ${assignment.id}${input.reviewerId ? ` by ${input.reviewerId}` : ''}`,
      { workerId: input.reviewerId, assignmentId: assignment.id },
    ),
  )
  mission.updatedAt = now()
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return mission
}

function _legacymarkMissionAssignmentsReviewedByWorker(input: {
  missionId?: string | null
  reviewerId: string
  excludeAssignmentId?: string | null
}): { mission: SwarmMission; reviewedAssignmentIds: Array<string> } | null {
  if (!input.missionId) return null
  const store = readStore()
  const mission = store.missions.find((item) => item.id === input.missionId)
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
    assignment.state = 'done'
    assignment.reviewedAt = reviewedAt
    assignment.reviewedBy = input.reviewerId
    mission.events.push(
      event('review', `Reviewed ${assignment.id} by ${input.reviewerId}`, {
        workerId: input.reviewerId,
        assignmentId: assignment.id,
      }),
    )
  }

  mission.updatedAt = reviewedAt
  mission.state = deriveMissionState(mission.assignments)
  writeStore(store)
  return {
    mission,
    reviewedAssignmentIds: reviewed.map((assignment) => assignment.id),
  }
}

function _legacylistSwarmReports(input?: {
  missionId?: string | null
  workerId?: string | null
  limit?: number
}): Array<SwarmCheckpointReport> {
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100))
  const mission = input?.missionId ? _legacygetSwarmMission(input.missionId) : null
  const missions = mission ? [mission] : readStore().missions

  return missions
    .flatMap((entry) => entry.events)
    .filter((event) => event.type === 'checkpoint' && event.data)
    .map((event) => event.data as SwarmCheckpointReport)
    .filter((report) => !input?.workerId || report.workerId === input.workerId)
    .sort((a, b) => b.recordedAt - a.recordedAt)
    .slice(0, limit)
}

export const listSwarmMissions = (limit?: number): Array<SwarmMission> =>
  getMissionRepository().listMissions(limit)

export const getSwarmMission = (missionId: string): SwarmMission | null =>
  getMissionRepository().getMission(missionId)

export const archiveStaleMissions = (staleMs?: number): { archivedIds: Array<string>; count: number } =>
  getMissionRepository().archiveStaleMissions(staleMs)

export const createOrUpdateMission = (
  input: Parameters<MissionRepository['createOrUpdateMission']>[0],
): CreateOrUpdateMissionResult => getMissionRepository().createOrUpdateMission(input)

export const markMissionAssignmentDispatched = (
  input: Parameters<MissionRepository['markAssignmentDispatched']>[0],
): SwarmMission | null => getMissionRepository().markAssignmentDispatched(input)

export const recordMissionCheckpoint = (
  input: Parameters<MissionRepository['recordCheckpoint']>[0],
): RecordCheckpointResult => getMissionRepository().recordCheckpoint(input)

export const recordMissionAssignmentBlocked = (
  input: Parameters<MissionRepository['recordAssignmentBlocked']>[0],
): ReturnType<MissionRepository['recordAssignmentBlocked']> =>
  getMissionRepository().recordAssignmentBlocked(input)

export const appendMissionContinuation = (
  input: Parameters<MissionRepository['appendContinuation']>[0],
): SwarmMission | null => getMissionRepository().appendContinuation(input)

export const readyQueuedAssignments = (
  missionId: string,
): Array<SwarmMissionAssignment> =>
  getMissionRepository().readyQueuedAssignments(missionId)

export const requeueMissionAssignment = (
  input: Parameters<MissionRepository['requeueAssignment']>[0],
): SwarmMission | null => getMissionRepository().requeueAssignment(input)

export const requeueAssignmentForRework = (
  input: Parameters<MissionRepository['requeueAssignmentForRework']>[0],
): SwarmMission | null => getMissionRepository().requeueAssignmentForRework(input)

export const setAssignmentBaseRef = (
  missionId: string,
  assignmentId: string,
  baseRef: string,
): SwarmMission | null =>
  getMissionRepository().setAssignmentBaseRef(missionId, assignmentId, baseRef)

export const setAssignmentHeadSha = (
  missionId: string,
  assignmentId: string,
  headSha: string,
): SwarmMission | null =>
  getMissionRepository().setAssignmentHeadSha(missionId, assignmentId, headSha)

export const setMissionTaskId = (
  input: Parameters<MissionRepository['setMissionTaskId']>[0],
): SwarmMission | null => getMissionRepository().setMissionTaskId(input)

export const updateMissionRoomId = (
  input: Parameters<MissionRepository['updateMissionRoomId']>[0],
): SwarmMission | null => getMissionRepository().updateMissionRoomId(input)

export const patchMissionFields = (
  input: Parameters<MissionRepository['patchMissionFields']>[0],
): SwarmMission | null => getMissionRepository().patchMissionFields(input)

export const deleteSwarmMission = (missionId: string): boolean =>
  getMissionRepository().deleteMission(missionId)

export const rewriteAssignmentDependencies = (
  input: Parameters<MissionRepository['rewriteAssignmentDependencies']>[0],
): SwarmMission | null => getMissionRepository().rewriteAssignmentDependencies(input)

export const cancelSwarmAssignment = (
  input: Parameters<MissionRepository['cancelAssignment']>[0],
): ReturnType<MissionRepository['cancelAssignment']> =>
  getMissionRepository().cancelAssignment(input)

export const appendSwarmMissionOrchestratorEvent = (
  input: Parameters<MissionRepository['appendOrchestratorEvent']>[0],
): SwarmMission | null => getMissionRepository().appendOrchestratorEvent(input)

export const cancelSwarmMission = (
  input: Parameters<MissionRepository['cancelMission']>[0],
): ReturnType<MissionRepository['cancelMission']> =>
  getMissionRepository().cancelMission(input)

export const markMissionAssignmentReviewed = (
  input: Parameters<MissionRepository['markAssignmentReviewed']>[0],
): SwarmMission | null => getMissionRepository().markAssignmentReviewed(input)

export const markMissionAssignmentsReviewedByWorker = (
  input: Parameters<MissionRepository['markAssignmentsReviewedByWorker']>[0],
): ReturnType<MissionRepository['markAssignmentsReviewedByWorker']> =>
  getMissionRepository().markAssignmentsReviewedByWorker(input)

export const listSwarmReports = (
  input?: Parameters<MissionRepository['listReports']>[0],
): Array<SwarmCheckpointReport> => getMissionRepository().listReports(input)

// ── Repository facade (SQLite source of truth, JSON as export cache) ─────

let missionRepository: MissionRepository | null = null

function getMissionRepository(): MissionRepository {
  if (!missionRepository) {
    missionRepository =
      process.env.AGORAX_MISSION_SQLITE_SOT === '1'
        ? new SqliteMissionRepository()
        : new JsonMissionRepository()
  }
  return missionRepository
}

/** Test hook: replace the repository singleton. */
export function setMissionRepositoryForTests(
  repo: MissionRepository | null,
): void {
  missionRepository = repo
}

/** Backwards-compatible JSON backend: wraps the legacy in-memory JSON store. */
class JsonMissionRepository implements MissionRepository {
  listMissions(limit?: number) {
    return _legacylistSwarmMissions(limit)
  }
  getMission(missionId: string) {
    return _legacygetSwarmMission(missionId)
  }
  createOrUpdateMission(input: Parameters<MissionRepository['createOrUpdateMission']>[0]) {
    return _legacycreateOrUpdateMission(input)
  }
  markAssignmentDispatched(input: Parameters<MissionRepository['markAssignmentDispatched']>[0]) {
    return _legacymarkMissionAssignmentDispatched(input)
  }
  recordCheckpoint(input: Parameters<MissionRepository['recordCheckpoint']>[0]) {
    return _legacyRecordMissionCheckpoint(input)
  }
  recordAssignmentBlocked(input: Parameters<MissionRepository['recordAssignmentBlocked']>[0]) {
    return _legacyrecordMissionAssignmentBlocked(input)
  }
  appendContinuation(input: Parameters<MissionRepository['appendContinuation']>[0]) {
    return _legacyappendMissionContinuation(input)
  }
  readyQueuedAssignments(missionId: string) {
    return _legacyreadyQueuedAssignments(missionId)
  }
  requeueAssignment(input: Parameters<MissionRepository['requeueAssignment']>[0]) {
    return _legacyrequeueMissionAssignment(input)
  }
  requeueAssignmentForRework(input: Parameters<MissionRepository['requeueAssignmentForRework']>[0]) {
    return _legacyrequeueAssignmentForRework(input)
  }
  setAssignmentBaseRef(missionId: string, assignmentId: string, baseRef: string) {
    return _legacysetAssignmentBaseRef(missionId, assignmentId, baseRef)
  }
  setAssignmentHeadSha(missionId: string, assignmentId: string, headSha: string) {
    return _legacysetAssignmentHeadSha(missionId, assignmentId, headSha)
  }
  setMissionTaskId(input: Parameters<MissionRepository['setMissionTaskId']>[0]) {
    return _legacysetMissionTaskId(input)
  }
  updateMissionRoomId(input: Parameters<MissionRepository['updateMissionRoomId']>[0]) {
    return _legacyupdateMissionRoomId(input)
  }
  patchMissionFields(input: Parameters<MissionRepository['patchMissionFields']>[0]) {
    return _legacypatchMissionFields(input)
  }
  deleteMission(missionId: string) {
    return _legacydeleteSwarmMission(missionId)
  }
  rewriteAssignmentDependencies(input: Parameters<MissionRepository['rewriteAssignmentDependencies']>[0]) {
    return _legacyrewriteAssignmentDependencies(input)
  }
  cancelAssignment(input: Parameters<MissionRepository['cancelAssignment']>[0]) {
    return _legacycancelSwarmAssignment(input)
  }
  appendOrchestratorEvent(input: Parameters<MissionRepository['appendOrchestratorEvent']>[0]) {
    return _legacyappendSwarmMissionOrchestratorEvent(input)
  }
  cancelMission(input: Parameters<MissionRepository['cancelMission']>[0]) {
    return _legacycancelSwarmMission(input)
  }
  markAssignmentReviewed(input: Parameters<MissionRepository['markAssignmentReviewed']>[0]) {
    return _legacymarkMissionAssignmentReviewed(input)
  }
  markAssignmentsReviewedByWorker(input: Parameters<MissionRepository['markAssignmentsReviewedByWorker']>[0]) {
    return _legacymarkMissionAssignmentsReviewedByWorker(input)
  }
  listReports(input?: Parameters<MissionRepository['listReports']>[0]) {
    return _legacylistSwarmReports(input)
  }
  archiveStaleMissions(staleMs?: number) {
    return _legacyarchiveStaleMissions(staleMs)
  }
  exportToJson() {
    return _legacylistSwarmMissions(1000)
  }
}
