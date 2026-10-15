/**
 * Mission Control API client — Missions list (entity=Mission) + detail Tasks.
 */

export type AgentRuntimeLabel =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'deepseek-harness'

export type AgentProbeResult = {
  available: boolean
  version?: string | null
  detail?: string | null
}

export type AgentAvailability = 'online' | 'unstable' | 'offline'
export type AgentWorkload = 'working' | 'queued' | 'idle'

/** Folded display enum — prefer availability + workload. */
export type UnifiedAgentStatus =
  | 'active'
  | 'idle'
  | 'offline'
  | 'blocked'
  | 'error'
  | 'needsSetup'

export type AgentStatusEntry = {
  agentId: string
  runtime: AgentRuntimeLabel
  execution: string
  probe: AgentProbeResult
  status: {
    agentId: string
    runtime: AgentRuntimeLabel
    state: string
    currentTask: string | null
    taskId: string | null
    missionId: string | null
    needsHuman: boolean
    checkpointStatus: string
    lastSummary: string | null
    updatedAt: number
    /** Reachability axis (Multica-style). */
    availability: AgentAvailability
    /** Work-on-plate axis (Multica-style). */
    workload: AgentWorkload
    blocked: boolean
    error: boolean
    /** Folded legacy status for filters. */
    unifiedStatus: UnifiedAgentStatus
    needsSetup: boolean
  } | null
}

export type AgentsStatusResponse = {
  agents: Array<AgentStatusEntry>
  orphanProfiles: Array<string>
  checkedAt: number
}

export type MissionStatus =
  | 'todo'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'
  | 'cancelled'

/** @deprecated Use MissionStatus — column = status (Multica). */
export type KanbanLane = MissionStatus

export type MissionAssignee = {
  type: 'agent' | 'chat_group'
  id: string
}

export type MissionSummary = {
  title: string
  /** Effective status (board pin ?? derived). */
  status: MissionStatus
  /** @deprecated Prefer `status` */
  lane: MissionStatus
  missionId: string | null
  /** @deprecated Prefer `status` */
  missionState: string | null
  derivedStatus: MissionStatus | null
  /** @deprecated Prefer `derivedStatus` */
  derivedLane: MissionStatus | null
  currentAssignee: string | null
  currentStage: string | null
  executionMode: string | null
  assignee: MissionAssignee | null
  roomId: string | null
  pipelineId: string | null
  projectId: string | null
  priority: number | null
  labels: Array<string>
  taskCount: number
  boardLane: MissionStatus | null
}

/** @deprecated Prefer MissionSummary */
export type TaskSummary = MissionSummary

export type MissionsResponse = {
  missions: Array<MissionSummary>
  tasks?: Array<MissionSummary>
}

export type TasksResponse = {
  tasks: Array<MissionSummary>
  missions?: Array<MissionSummary>
}

export type PipelineStage = {
  assignmentId: string
  stageKey: string | null
  agent: string
  state: string
  stale: boolean
  dependsOn: Array<string>
  dispatchedAt: number | null
  completedAt: number | null
  createdByWorkerId?: string | null
  dispatchable?: boolean
}

export type MissionTaskRow = {
  id: string
  workerId: string
  task: string
  rationale: string | null
  state: string
  stageKey: string | null
  dependsOn: Array<string>
  createdByWorkerId: string | null
  dispatchable: boolean
  externalRef: unknown
  workspacePath: string | null
  dispatchedAt: number | null
  completedAt: number | null
}

export type TaskRun = {
  id: string
  mission_id: string
  assignment_id: string
  agent_id: string
  status: string
  summary: string | null
  started_at: number | null
  finished_at: number | null
}

export type MissionDetail = {
  mission: MissionSummary
  task: {
    id: string
    title: string
    spec: string
    acceptanceCriteria: Array<string>
    status: KanbanLane
    missionId: string | null
    [key: string]: unknown
  } | null
  tasks: Array<MissionTaskRow>
  pipeline: {
    id: string | null
    specVersion: number
    stages: Array<PipelineStage>
  } | null
  runs: Array<TaskRun>
  events: Array<{
    type: string
    at: number
    [key: string]: unknown
  }>
}

/** @deprecated Prefer MissionDetail */
export type TaskDetail = {
  task: NonNullable<MissionDetail['task']>
  pipeline: MissionDetail['pipeline']
  runs: Array<TaskRun>
  events: MissionDetail['events']
}

export async function fetchAgentsStatus(): Promise<AgentsStatusResponse> {
  const res = await fetch('/api/agents/status')
  if (!res.ok) throw new Error(`Failed to fetch agents status: ${res.status}`)
  return res.json()
}

export async function fetchMissions(): Promise<MissionsResponse> {
  const res = await fetch('/api/missions')
  if (!res.ok) {
    // Compat fallback during rollout
    const legacy = await fetch('/api/tasks')
    if (!legacy.ok) throw new Error(`Failed to fetch missions: ${res.status}`)
    const data = (await legacy.json()) as TasksResponse
    return { missions: data.tasks ?? [], tasks: data.tasks }
  }
  const data = (await res.json()) as MissionsResponse
  return {
    missions: data.missions ?? data.tasks ?? [],
    tasks: data.tasks ?? data.missions,
  }
}

export async function fetchTasks(): Promise<TasksResponse> {
  const data = await fetchMissions()
  return { tasks: data.missions, missions: data.missions }
}

export async function fetchMissionDetail(
  missionId: string,
): Promise<MissionDetail> {
  const res = await fetch(`/api/missions/${missionId}`)
  if (!res.ok) {
    // Compat: older /api/tasks/:id shape
    const legacy = await fetch(`/api/tasks/${missionId}`)
    if (!legacy.ok)
      throw new Error(`Failed to fetch mission detail: ${res.status}`)
    const data = (await legacy.json()) as TaskDetail & {
      tasks?: Array<MissionTaskRow>
      mission?: MissionSummary
    }
    return {
      mission: data.mission ?? {
        title: data.task.title,
        status: data.task.status as MissionStatus,
        lane: data.task.status as MissionStatus,
        missionId: data.task.missionId,
        missionState: null,
        derivedStatus: null,
        derivedLane: null,
        currentAssignee: null,
        currentStage: null,
        executionMode: null,
        assignee: null,
        roomId: null,
        pipelineId: data.pipeline?.id ?? null,
        projectId: null,
        priority: null,
        labels: [],
        taskCount: data.pipeline?.stages.length ?? 0,
        boardLane: null,
      },
      task: data.task,
      tasks:
        data.tasks ??
        (data.pipeline?.stages.map((s) => ({
          id: s.assignmentId,
          workerId: s.agent,
          task: '',
          rationale: null,
          state: s.state,
          stageKey: s.stageKey,
          dependsOn: s.dependsOn,
          createdByWorkerId: s.createdByWorkerId ?? null,
          dispatchable: true,
          externalRef: null,
          workspacePath: null,
          dispatchedAt: s.dispatchedAt,
          completedAt: s.completedAt,
        })) ??
          []),
      pipeline: data.pipeline,
      runs: data.runs,
      events: data.events,
    }
  }
  return res.json()
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  const detail = await fetchMissionDetail(taskId)
  return {
    task: detail.task ?? {
      id: detail.mission.missionId ?? '',
      title: detail.mission.title,
      spec: '',
      acceptanceCriteria: [],
      status: detail.mission.lane,
      missionId: detail.mission.missionId,
    },
    pipeline: detail.pipeline,
    runs: detail.runs,
    events: detail.events,
  }
}

export async function startMission(missionId: string): Promise<{
  ok: boolean
  dispatched: Array<{
    assignmentId: string
    workerId: string
    ok: boolean
    error?: string
  }>
}> {
  const res = await fetch(`/api/missions/${missionId}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const legacy = await fetch(`/api/tasks/${missionId}`, {
      method: 'POST',
    })
    const data = (await legacy.json().catch(() => ({}))) as {
      error?: string
      dispatched?: unknown
    }
    if (!legacy.ok || data.error) {
      throw new Error(data.error || `Failed to start mission: ${legacy.status}`)
    }
    return {
      ok: true,
      dispatched: Array.isArray(data.dispatched) ? data.dispatched : [],
    }
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    dispatched?: unknown
  }
  if (data.error) throw new Error(data.error)
  return {
    ok: true,
    dispatched: Array.isArray(data.dispatched) ? data.dispatched : [],
  }
}

/** @deprecated Prefer startMission */
export async function startTask(taskId: string) {
  return startMission(taskId)
}

export type PatchMissionInput = {
  title?: string
  spec?: string
  acceptanceCriteria?: Array<string>
  assignee?: MissionAssignee | null
  roomId?: string | null
  projectId?: string | null
  priority?: number | null
  labels?: Array<string>
  /** Status pin (Multica column). Alias of `status`. */
  boardLane?: MissionStatus | null
  status?: MissionStatus | null
}

export async function patchMission(
  missionId: string,
  patch: PatchMissionInput,
): Promise<MissionSummary> {
  const res = await fetch(`/api/missions/${missionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    mission?: MissionSummary
  }
  if (!res.ok || data.error || !data.mission) {
    throw new Error(data.error || `Failed to patch mission: ${res.status}`)
  }
  return data.mission
}

export async function deleteMission(missionId: string): Promise<{
  ok: boolean
  missionId: string | null
}> {
  const res = await fetch(`/api/missions/${missionId}`, {
    method: 'DELETE',
    // Avoid infinite "Deleting…" if the workspace SSR process is wedged.
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    ok?: boolean
    missionId?: string | null
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `Failed to delete mission: ${res.status}`)
  }
  return {
    ok: true,
    missionId: data.missionId ?? null,
  }
}

export type ProjectOption = {
  id: string
  repo: string
  defaultBranch: string
  selfHosted: boolean
}

export async function fetchProjects(): Promise<Array<ProjectOption>> {
  const res = await fetch('/api/projects')
  if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`)
  const data = (await res.json()) as {
    projects?: Array<ProjectOption>
    error?: string
  }
  if (data.error && (!data.projects || data.projects.length === 0)) {
    throw new Error(data.error)
  }
  return data.projects ?? []
}

export type CollabEvent = {
  event: string
  data: Record<string, unknown>
}

export function subscribeCollabEvents(
  params: { scope?: string; roomId?: string; sessionKey?: string },
  onEvent: (event: CollabEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const q = new URLSearchParams()
  if (params.scope) q.set('scope', params.scope)
  if (params.roomId) q.set('roomId', params.roomId)
  if (params.sessionKey) q.set('sessionKey', params.sessionKey)
  const url = `/api/collab-events?${q.toString()}`

  const source = new EventSource(url)
  source.onmessage = (message) => {
    try {
      const parsed = JSON.parse(message.data) as Record<string, unknown>
      onEvent({ event: message.lastEventId || 'message', data: parsed })
    } catch (err) {
      onError?.(
        err instanceof Error ? err : new Error('Failed to parse SSE message'),
      )
    }
  }
  source.onerror = () => {
    onError?.(new Error('SSE connection error'))
  }

  return () => {
    source.close()
  }
}
