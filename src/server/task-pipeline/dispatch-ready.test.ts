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

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'dispatch-ready-test-'))
  mkdirSync(join(tempRoot, '.runtime'), { recursive: true })

  vi.doMock('../swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))

  vi.doMock('../../routes/api/swarm-dispatch', () => ({
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
  const swarmDispatch = await import('../../routes/api/swarm-dispatch')
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
    vi.doUnmock('../../routes/api/swarm-dispatch')
    vi.doUnmock('../agent-runtime/dispatch')
    vi.doUnmock('../agent-runtime/router')
    vi.doUnmock('../kanban-backend')
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
    const { mod, swarm, swarmDispatch, agentDispatch, router } = await loadModule()
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
    vi.mocked(swarmDispatch.dispatchSwarmAssignments).mockResolvedValue({
      results: [
        { ok: true, workerId: 'researcher', error: null },
        { ok: false, workerId: 'architect', error: 'tmux unavailable' },
      ],
    } as never)

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
    const call = vi.mocked(swarmDispatch.dispatchSwarmAssignments).mock.calls[0][0] as {
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
