import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SwarmDispatchModule from '../swarm-dispatch-service'
import type * as CollabDbModule from '../collab-db'

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'dispatch-ready-test-'))
  mkdirSync(join(tempRoot, '.runtime'), { recursive: true })

  vi.doMock('../collab-db', async () => {
    const actual = await vi.importActual<typeof CollabDbModule>('../collab-db')
    return { ...actual, getCollabDbPath: () => join(tempRoot, 'collab.db') }
  })

  vi.doMock('../swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))

  vi.doMock('../swarm-dispatch-service', () => ({
    dispatchSwarmAssignments: vi.fn(),
  }))

  vi.doMock('../agent-runtime/dispatch', () => ({
    dispatchAssignment: vi.fn(),
  }))

  vi.doMock('../agent-runtime/router', () => ({
    getAgentRuntimeRouter: vi.fn(),
    resetAgentRuntimeRouter: vi.fn(),
    setAgentRuntimeRouterForTests: vi.fn(),
  }))

  vi.doMock('../kanban-backend', () => ({
    updateKanbanCard: vi.fn().mockResolvedValue(undefined),
    createKanbanCard: vi.fn().mockResolvedValue({ id: 'card-1' }),
    listKanbanCards: vi.fn().mockResolvedValue([]),
  }))

  const mod = await import('./dispatch-ready')
  const swarm = await import('../swarm-missions')
  const swarmDispatch = await import('../swarm-dispatch-service')
  const agentDispatch = await import('../agent-runtime/dispatch')
  const router = await import('../agent-runtime/router')
  const kanban = await import('../kanban-backend')
  return { mod, swarm, swarmDispatch, agentDispatch, router, kanban }
}

function mockRouter(registry: Array<{ id: string; runtime: string }>) {
  const byId = new Map(registry.map((a) => [a.id, a]))
  return {
    registry: {
      agents: registry,
      byId,
    },
  }
}

describe('dispatch-ready', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dispatch-ready-test-'))
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../swarm-environment')
    vi.doUnmock('../collab-db')
    vi.doUnmock('../swarm-dispatch-service')
    vi.doUnmock('../agent-runtime/dispatch')
    vi.doUnmock('../agent-runtime/router')
    vi.doUnmock('../kanban-backend')
    vi.doUnmock('../swarm-roster')
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns empty summary when no assignments are ready', async () => {
    const { mod, swarm } = await loadModule()
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-empty',
      title: 'Empty',
      assignments: [
        { workerId: 'researcher', task: 'T1', dependsOn: ['missing'] },
      ],
    })

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.dispatched).toHaveLength(0)
    expect(result.ok).toBe(true)
  })

  it('only dispatches assignments that fit the remaining scheduler capacity', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    const scheduler = await import('./task-scheduler')
    for (let index = 0; index < 9; index++) {
      scheduler.markTaskRunning({
        missionId: 'occupied',
        assignmentId: `occupied-${index}`,
      })
    }
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([
        { id: 'researcher', runtime: 'hermes' },
        { id: 'architect', runtime: 'hermes' },
      ]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [{ ok: true, workerId: 'researcher', error: null }],
    } as never)
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-capacity',
      title: 'Capacity',
      assignments: [
        { workerId: 'researcher', task: 'Research' },
        { workerId: 'architect', task: 'Design' },
      ],
    })

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.dispatched).toHaveLength(1)
    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledWith(
      expect.objectContaining({ assignments: expect.any(Array) }),
      expect.any(Map),
    )
    const request = vi.mocked(swarmDispatch.dispatchSwarmAssignments).mock
      .calls[0][0]
    expect(request.assignments).toHaveLength(1)
    expect(scheduler.availableSlots()).toBe(0)
  })

  it('does not dispatch the same assignment during concurrent kickoff requests', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([{ id: 'researcher', runtime: 'hermes' }]) as never,
    )
    let finishDispatch!: () => void
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockImplementation(
      async () => {
        await new Promise<void>((resolve) => {
          finishDispatch = resolve
        })
        return {
          results: [{ ok: true, workerId: 'researcher', error: null }],
        } as never
      },
    )
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-concurrent',
      title: 'Concurrent',
      assignments: [{ workerId: 'researcher', task: 'Research' }],
    })

    const first = mod.dispatchReadyAssignments(mission.id)
    const second = await mod.dispatchReadyAssignments(mission.id)

    expect(second.dispatched).toEqual([])
    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledTimes(1)
    finishDispatch()
    expect((await first).dispatched).toHaveLength(1)
  })

  it('releases failed dispatches and records an actionable blocked assignment', async () => {
    const { mod, swarm, agentDispatch, router } = await loadModule()
    const scheduler = await import('./task-scheduler')
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([{ id: 'cc-impl', runtime: 'claude-code' }]) as never,
    )
    vi.mocked(agentDispatch.dispatchAssignment).mockImplementation(
      ({ missionId, assignmentId }) => {
        swarm.markMissionAssignmentDispatched({
          missionId,
          assignmentId,
          workerId: 'cc-impl',
          task: 'Implement',
        })
        return Promise.resolve({ ok: false, error: 'daemon unavailable' })
      },
    )
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-failed',
      title: 'Failed',
      assignments: [{ workerId: 'cc-impl', task: 'Implement' }],
    })

    expect((await mod.dispatchReadyAssignments(mission.id)).ok).toBe(false)
    expect(scheduler.availableSlots()).toBe(10)
    expect(swarm.getSwarmMission(mission.id)?.assignments[0]).toMatchObject({
      state: 'blocked',
      checkpoint: { blocker: 'daemon unavailable' },
    })
  })

  it('dispatches waiting work after a completed assignment releases capacity', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    const scheduler = await import('./task-scheduler')
    for (let index = 0; index < 9; index++) {
      scheduler.markTaskRunning({
        missionId: 'occupied',
        assignmentId: `occupied-${index}`,
      })
    }
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([
        { id: 'researcher', runtime: 'hermes' },
        { id: 'architect', runtime: 'hermes' },
      ]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockImplementation(
      (request) => {
        const assignments = request.assignments as Array<{
          assignmentId: string
          workerId: string
          task: string
        }>
        for (const assignment of assignments) {
          swarm.markMissionAssignmentDispatched({
            missionId: String(request.missionId),
            ...assignment,
          })
        }
        return Promise.resolve({
          results: assignments.map((assignment) => ({
            ok: true,
            workerId: assignment.workerId,
            error: null,
          })),
        } as never)
      },
    )
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-refill',
      title: 'Refill',
      assignments: [
        { workerId: 'researcher', task: 'Research' },
        { workerId: 'architect', task: 'Design' },
      ],
    })
    const first = await mod.dispatchReadyAssignments(mission.id)
    expect(first.dispatched).toHaveLength(1)
    swarm.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId: first.dispatched[0].assignmentId,
      workerId: first.dispatched[0].workerId,
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        result: 'Finished',
        filesChanged: null,
        commandsRun: null,
        blocker: null,
        nextAction: null,
        reviewOutcome: null,
        raw: 'STATE: DONE\nRESULT: Finished',
      },
    })

    await scheduler.tickTaskScheduler()

    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledTimes(2)
    expect(
      swarm
        .getSwarmMission(mission.id)
        ?.assignments.filter((assignment) => assignment.state === 'dispatched'),
    ).toHaveLength(1)
    expect(scheduler.availableSlots()).toBe(0)
  })

  it('fills capacity with the requested assignment rather than another ready sibling', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    const scheduler = await import('./task-scheduler')
    for (let index = 0; index < 10; index++) {
      scheduler.markTaskRunning({
        missionId: 'occupied',
        assignmentId: `occupied-${index}`,
      })
    }
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([
        { id: 'researcher', runtime: 'hermes' },
        { id: 'architect', runtime: 'hermes' },
      ]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [{ ok: true, workerId: 'architect', error: null }],
    } as never)
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-targeted',
      title: 'Targeted continuation',
      assignments: [
        { workerId: 'researcher', task: 'Not requested yet' },
        { workerId: 'architect', task: 'Prepared continuation' },
      ],
    })
    const target = mission.assignments.find(
      (assignment) => assignment.workerId === 'architect',
    )!
    await mod.dispatchReadyAssignments(mission.id, { assignmentId: target.id })
    scheduler.releaseTaskClaim('occupied-0')

    await scheduler.tickTaskScheduler()

    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledTimes(1)
    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledWith(
      expect.objectContaining({
        assignments: [expect.objectContaining({ assignmentId: target.id })],
      }),
      expect.any(Map),
    )
  })

  it('retries only unstarted work with backoff and stops after three retries', async () => {
    const { mod, swarm, agentDispatch, router } = await loadModule()
    const scheduler = await import('./task-scheduler')
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([{ id: 'cc-impl', runtime: 'claude-code' }]) as never,
    )
    vi.mocked(agentDispatch.dispatchAssignment).mockResolvedValue({
      ok: false,
      error: 'temporarily unavailable',
    })
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-retry',
      title: 'Retry',
      assignments: [{ workerId: 'cc-impl', task: 'Implement' }],
    })

    await mod.dispatchReadyAssignments(mission.id)
    expect(scheduler.getSchedulerSnapshot().retrying[0].attempt).toBe(1)
    await mod.dispatchReadyAssignments(mission.id)
    expect(agentDispatch.dispatchAssignment).toHaveBeenCalledTimes(1)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retry = scheduler.getSchedulerSnapshot().retrying[0]
      expect(retry.attempt).toBe(attempt)
      await scheduler.processDueRetries(retry.dueAtMs)
    }

    expect(agentDispatch.dispatchAssignment).toHaveBeenCalledTimes(4)
    expect(scheduler.getSchedulerSnapshot().retrying).toEqual([])
    expect(scheduler.availableSlots()).toBe(10)
    expect(swarm.getSwarmMission(mission.id)?.assignments[0].state).toBe(
      'blocked',
    )
  })

  it('enforces capacity on direct Hermes dispatch without rewriting the mission', async () => {
    const { swarm } = await loadModule()
    const scheduler = await import('./task-scheduler')
    vi.doMock('../swarm-roster', () => ({
      rosterByWorkerId: vi.fn(() => new Map()),
    }))
    const direct = await vi.importActual<typeof SwarmDispatchModule>(
      '../swarm-dispatch-service',
    )
    for (let index = 0; index < 10; index++) {
      scheduler.markTaskRunning({
        missionId: 'occupied',
        assignmentId: `occupied-${index}`,
      })
    }
    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-direct',
      title: 'Preserved mission',
      spec: 'Preserve this specification',
      acceptanceCriteria: ['Preserve this acceptance criterion'],
      assignments: [{ workerId: 'researcher', task: 'Research' }],
    })

    const result = await direct.dispatchSwarmAssignments({
      missionId: mission.id,
      waitForCheckpoint: true,
      assignments: [
        {
          assignmentId: mission.assignments[0].id,
          workerId: 'researcher',
          task: 'Research',
        },
      ],
    })

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('scheduler capacity'),
    })
    expect(swarm.getSwarmMission(mission.id)).toMatchObject({
      spec: mission.spec,
      acceptanceCriteria: mission.acceptanceCriteria,
      assignments: [{ id: mission.assignments[0].id, state: 'queued' }],
    })
  })

  it('dispatches hermes assignments via swarm-dispatch', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([{ id: 'researcher', runtime: 'hermes' }]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [{ ok: true, workerId: 'researcher', error: null }],
    } as never)

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-hermes',
      title: 'Hermes mission',
      projectId: null,
      workspaceMode: 'canonical',
      assignments: [{ workerId: 'researcher', task: 'Research' }],
    })
    mission.taskId = 'card-1'

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.dispatched).toHaveLength(1)
    expect(result.dispatched[0]).toMatchObject({
      workerId: 'researcher',
      ok: true,
    })
    expect(result.dispatched[0]?.assignmentId).toBeTruthy()
    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: mission.id,
        allowAsync: true,
        assignments: expect.arrayContaining([
          expect.objectContaining({
            workerId: 'researcher',
            task: 'Research',
            direct: false,
          }),
        ]),
      }),
      expect.any(Map),
    )
  })

  it('dispatches managed assignments via agent-runtime dispatchAssignment', async () => {
    const { mod, swarm, agentDispatch, router } = await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([{ id: 'cc-impl', runtime: 'claude-code' }]) as never,
    )
    vi.mocked(agentDispatch.dispatchAssignment).mockResolvedValue({
      ok: true,
      runId: 'run-1',
      assignmentId: 'assign-1',
    })

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-managed',
      title: 'Managed mission',
      projectId: null,
      workspaceMode: 'canonical',
      assignments: [{ workerId: 'cc-impl', task: 'Implement' }],
    })
    mission.taskId = 'card-1'

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.dispatched).toHaveLength(1)
    expect(result.dispatched[0]).toMatchObject({
      workerId: 'cc-impl',
      ok: true,
    })
    expect(agentDispatch.dispatchAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: mission.id,
        assignmentId: result.dispatched[0]?.assignmentId,
      }),
    )
  })

  it('routes hermes and managed assignments separately in one call', async () => {
    const { mod, swarm, swarmDispatch, agentDispatch, router } =
      await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([
        { id: 'researcher', runtime: 'hermes' },
        { id: 'cc-impl', runtime: 'claude-code' },
      ]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [{ ok: true, workerId: 'researcher', error: null }],
    } as never)
    vi.mocked(agentDispatch.dispatchAssignment).mockResolvedValue({
      ok: true,
      runId: 'run-1',
      assignmentId: 'assign-1',
    })

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-mixed',
      title: 'Mixed mission',
      projectId: null,
      workspaceMode: 'canonical',
      assignments: [
        { workerId: 'researcher', task: 'Research' },
        { workerId: 'cc-impl', task: 'Implement' },
      ],
    })
    mission.taskId = 'card-1'

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.dispatched).toHaveLength(2)
    expect(result.ok).toBe(true)
    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalledTimes(1)
    expect(agentDispatch.dispatchAssignment).toHaveBeenCalledTimes(1)
    const swarmCall = vi.mocked(swarmDispatch.dispatchSwarmAssignments).mock
      .calls[0][0] as { assignments: Array<{ workerId: string }> }
    expect(swarmCall.assignments.map((a) => a.workerId)).toEqual(['researcher'])
  })

  it('captures per-assignment errors without rolling back', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([
        { id: 'researcher', runtime: 'hermes' },
        { id: 'architect', runtime: 'hermes' },
      ]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockImplementation(
      (request) =>
        Promise.resolve({
          results: (request.assignments as Array<{ workerId: string }>).map(
            ({ workerId }) => ({
              ok: workerId !== 'architect',
              workerId,
              error: workerId === 'architect' ? 'tmux unavailable' : null,
            }),
          ),
        } as never),
    )

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-partial',
      title: 'Partial mission',
      projectId: null,
      workspaceMode: 'canonical',
      assignments: [
        { workerId: 'researcher', task: 'R' },
        { workerId: 'architect', task: 'A' },
      ],
    })
    mission.taskId = 'card-1'

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.ok).toBe(false)
    const failed = result.dispatched.find((d) => d.workerId === 'architect')
    expect(failed?.ok).toBe(false)
    expect(failed?.error).toContain('tmux unavailable')
    const passed = result.dispatched.find((d) => d.workerId === 'researcher')
    expect(passed?.ok).toBe(true)
  })

  it('dispatches without kanban card sync', async () => {
    const { mod, swarm, swarmDispatch, router, kanban } = await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([{ id: 'researcher', runtime: 'hermes' }]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [{ ok: true, workerId: 'researcher', error: null }],
    } as never)

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-lane',
      title: 'Lane sync mission',
      projectId: null,
      workspaceMode: 'canonical',
      assignments: [{ workerId: 'researcher', task: 'Research' }],
    })
    swarm.rewriteAssignmentDependencies({
      missionId: mission.id,
      dependsOnByAssignmentId: Object.fromEntries(
        mission.assignments.map((a) => [a.id, a.dependsOn]),
      ),
      pipelineId: 'default-build',
      taskId: null,
    })

    const result = await mod.dispatchReadyAssignments(mission.id)

    expect(result.dispatched).toHaveLength(1)
    expect(kanban.updateKanbanCard).not.toHaveBeenCalled()
  })

  it('createTask autoDispatch=true triggers kickoff', async () => {
    const { swarmDispatch, router, kanban } = await loadModule()
    writeFileSync(
      join(tempRoot, 'pipelines.yaml'),
      `version: 1
pipelines:
  - id: default-build
    name: Default
    workspaceMode: canonical
    stages:
      - key: research
        agent: researcher
        dependsOn: []
`,
    )
    writeFileSync(
      join(tempRoot, 'agents.yaml'),
      `version: 2
agents:
  - id: researcher
    name: Researcher
    role: research
    specialty: research
    mission: research
    profile: researcher
    modes: [quick]
    tools: []
    skills: []
    plugins: []
    pluginToolsets: []
    mcpServers: []
    wrapper: researcher:quick
    capabilities: [research]
    enabled: true
    runtime: hermes
    execution: local
    dispatchable: true
`,
    )
    const prev = process.cwd()
    process.chdir(tempRoot)
    try {
      vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
        mockRouter([{ id: 'researcher', runtime: 'hermes' }]) as never,
      )
      vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
        results: [{ ok: true, workerId: 'researcher', error: null }],
      } as never)

      const { createTask } = await import('./task-service')
      const created = await createTask({
        title: 'Auto dispatch test',
        spec: 'spec',
        pipelineId: 'default-build',
        acceptanceCriteria: [],
        autoDispatch: true,
      })

      expect(created.dispatched).toHaveLength(1)
      expect(created.dispatched[0]?.workerId).toBe('researcher')
      expect(created.dispatched[0]?.ok).toBe(true)
      expect(created.missionId).toBeTruthy()
      expect(kanban.updateKanbanCard).not.toHaveBeenCalled()
    } finally {
      process.chdir(prev)
    }
  })

  it('createTask autoDispatch=false does not kickoff', async () => {
    const { swarmDispatch, router, kanban } = await loadModule()
    writeFileSync(
      join(tempRoot, 'pipelines.yaml'),
      `version: 1
pipelines:
  - id: default-build
    name: Default
    workspaceMode: canonical
    stages:
      - key: research
        agent: researcher
        dependsOn: []
`,
    )
    writeFileSync(
      join(tempRoot, 'agents.yaml'),
      `version: 2
agents:
  - id: researcher
    name: Researcher
    role: research
    specialty: research
    mission: research
    profile: researcher
    modes: [quick]
    tools: []
    skills: []
    plugins: []
    pluginToolsets: []
    mcpServers: []
    wrapper: researcher:quick
    capabilities: [research]
    enabled: true
    runtime: hermes
    execution: local
    dispatchable: true
`,
    )
    const prev = process.cwd()
    process.chdir(tempRoot)
    try {
      vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
        mockRouter([{ id: 'researcher', runtime: 'hermes' }]) as never,
      )

      const { createTask } = await import('./task-service')
      const created = await createTask({
        title: 'No auto dispatch test',
        spec: 'spec',
        pipelineId: 'default-build',
        acceptanceCriteria: [],
        autoDispatch: false,
      })

      expect(created.dispatched).toHaveLength(0)
      expect(swarmDispatch.dispatchSwarmAssignments).not.toHaveBeenCalled()
      expect(kanban.updateKanbanCard).not.toHaveBeenCalled()
    } finally {
      process.chdir(prev)
    }
  })

  it('fires checkpoint continuation hook for pipeline missions', async () => {
    const { mod, swarm, swarmDispatch, router } = await loadModule()
    vi.mocked(router.getAgentRuntimeRouter).mockReturnValue(
      mockRouter([
        { id: 'researcher', runtime: 'hermes' },
        { id: 'architect', runtime: 'hermes' },
      ]) as never,
    )
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [{ ok: true, workerId: 'architect', error: null }],
    } as never)

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-continuation',
      title: 'Continuation mission',
      projectId: null,
      workspaceMode: 'canonical',
      assignments: [
        { workerId: 'researcher', task: 'R' },
        { workerId: 'architect', task: 'A', dependsOn: [] },
      ],
    })
    swarm.rewriteAssignmentDependencies({
      missionId: mission.id,
      dependsOnByAssignmentId: Object.fromEntries(
        mission.assignments.map((a) => [a.id, a.dependsOn]),
      ),
      pipelineId: 'default-build',
      taskId: 'card-1',
    })

    swarm.markMissionAssignmentDispatched({
      missionId: mission.id,
      workerId: 'researcher',
      task: 'R',
    })

    swarm.recordMissionCheckpoint({
      missionId: mission.id,
      workerId: 'researcher',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'none',
        commandsRun: 'none',
        result: 'Research complete',
        blocker: null,
        nextAction: 'handoff',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: Research complete\nBLOCKER: none\nNEXT_ACTION: handoff',
      },
    })

    // Hook is fire-and-forget; wait a tick for the microtask.
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(swarmDispatch.dispatchSwarmAssignments).toHaveBeenCalled()
    const call = vi.mocked(swarmDispatch.dispatchSwarmAssignments).mock
      .calls[0][0] as {
      assignments: Array<{ workerId: string }>
    }
    expect(call.assignments.map((a) => a.workerId)).toEqual(['architect'])
  })

  it('does not continue non-pipeline missions on terminal checkpoint', async () => {
    const { swarm, swarmDispatch } = await loadModule()

    const mission = swarm.createOrUpdateMission({
      missionId: 'mission-nocontinue',
      title: 'No continue',
      assignments: [{ workerId: 'researcher', task: 'R' }],
    })

    swarm.recordMissionCheckpoint({
      missionId: mission.id,
      workerId: 'researcher',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'none',
        commandsRun: 'none',
        result: 'Done',
        blocker: null,
        nextAction: 'none',
        reviewOutcome: null,
        raw: 'STATE: DONE\nRESULT: Done',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(swarmDispatch.dispatchSwarmAssignments).not.toHaveBeenCalled()
  })
})
