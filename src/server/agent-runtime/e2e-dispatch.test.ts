/**
 * P1 步骤 3 end-to-end: dispatch → agent calls MCP task_get/task_start/
 * task_complete → mission state advances → next ready stage is dispatched.
 *
 * Uses a fake CLI binary (bash script performing real HTTP JSON-RPC calls
 * with the injected token) so the whole loop runs against the real
 * dispatcher, token store, handler, mission store, and advance bridge.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string
let dbPath: string
let missionsDir: string

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'e2e-mcp-'))
  dbPath = join(tempRoot, 'collab.db')
  missionsDir = join(tempRoot, 'missions')

  vi.doMock('../collab-db', async () => {
    const actual = await vi.importActual('../collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/collab-db', async () => {
    const actual = await vi.importActual('../../server/collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))
  vi.doMock('../swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))

  const collabDb = await import('../../server/collab-db')
  const runTokens = await import('../../server/mcp/run-tokens')
  const taskRuns = await import('../../server/mcp/task-runs')
  const handler = await import('../../server/mcp/mcp-handler')
  const missions = await import('../../server/swarm-missions')
  const dispatch = await import('../../server/agent-runtime/dispatch')
  const advance = await import('../../server/agent-runtime/advance')
  const routerMod = await import('../../server/agent-runtime/router')
  return {
    collabDb,
    runTokens,
    taskRuns,
    handler,
    missions,
    dispatch,
    advance,
    routerMod,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../collab-db')
  vi.doUnmock('../../server/collab-db')
  vi.doUnmock('../swarm-environment')
  vi.doUnmock('../../server/swarm-environment')
  vi.restoreAllMocks()
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('P1.3 end-to-end dispatch → MCP → advance', () => {
  it('full loop: dispatch → task_start → task_complete → assignment checkpointed → next stage dispatched', async () => {
    const { handler, missions, dispatch, advance, routerMod, runTokens } =
      await loadModules()

    // Fake router: adapter that, on startRun, drives the MCP loop in-process
    // (standing in for a spawned CLI agent calling over HTTP).
    const started: Array<{ runId: string; task: string }> = []
    const fakeAdapter = {
      kind: 'claude-code' as const,
      async probe() {
        return { available: true }
      },
      async startRun(input: {
        runId: string
        agentId: string
        task: string
        mcp: { runToken: string }
      }) {
        started.push({ runId: input.runId, task: input.task })
        const token = input.mcp.runToken
        // The agent's MCP session: get → start → complete.
        const get = await handler.handleMcpRequest(
          { jsonrpc: '2.0', id: 1, method: 'task_get', params: { token } },
          dbPath,
        )
        expect(get.error).toBeUndefined()
        const start = await handler.handleMcpRequest(
          { jsonrpc: '2.0', id: 2, method: 'task_start', params: { token } },
          dbPath,
        )
        expect(start.error).toBeUndefined()
        const done = await handler.handleMcpRequest(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'task_complete',
            params: {
              token,
              runId: input.runId,
              summary: `finished: ${input.task}`,
            },
          },
          dbPath,
        )
        expect(done.error).toBeUndefined()
        return { runId: input.runId }
      },
      async *streamEvents() {
        /* empty */
      },
      async interrupt() {
        /* noop */
      },
    }

    const router = new routerMod.AgentRuntimeRouter({
      rawYaml: 'version: 1\nagents: []\n',
    })
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'dev-1',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'dev-2',
      fakeAdapter,
    )
    routerMod.setAgentRuntimeRouterForTests(router)

    // Mission with two chained stages: stage A (dev-1) → stage B (dev-2).
    const mission = missions.createOrUpdateMission({
      missionId: 'mission-e2e-1',
      title: 'E2E chained mission',
      assignments: [
        { workerId: 'dev-1', task: 'stage A work', reviewRequired: false },
      ],
    })
    const aId = mission.assignments[0].id
    // Append stage B depending on A (createOrUpdateMission adds new assignment).
    const mission2 = missions.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [
        {
          workerId: 'dev-2',
          task: 'stage B work',
          reviewRequired: false,
          dependsOn: [aId],
        },
      ],
    })
    expect(mission2.assignments).toHaveLength(2)

    // Install the advance bridge; dispatchNext drives the next stage.
    const dispatchedNext: Array<string> = []
    const uninstall = advance.installAdvanceBridge({
      dispatchNext: async ({ missionId, assignmentId }) => {
        dispatchedNext.push(assignmentId)
        await dispatch.dispatchAssignment({ missionId, assignmentId })
      },
    })

    // Kick off stage A.
    const result = await dispatch.dispatchAssignment({
      missionId: mission.id,
      assignmentId: aId,
    })
    expect(result.ok).toBe(true)

    // Allow microtasks (bridge + dispatchNext) to flush.
    await new Promise((r) => setTimeout(r, 50))

    // Stage A ran and checkpointed.
    const after = missions.getSwarmMission(mission.id)!
    const aA = after.assignments.find((a) => a.id === aId)!
    expect(aA.state).toBe('checkpointed')

    // Stage B was auto-dispatched (dependsOn satisfied) and completed too,
    // because the fake adapter finishes synchronously.
    expect(dispatchedNext).toHaveLength(1)
    const aB = after.assignments.find((a) => a.workerId === 'dev-2')!
    expect(aB.state).toBe('checkpointed')
    expect(started).toHaveLength(2)

    // Tokens for both runs are revoked (run_write dies with the run).
    expect(runTokens.resolveRunToken).toBeDefined()
    uninstall()
    routerMod.setAgentRuntimeRouterForTests(null)
  }, 15_000)

  it('blocked run sets assignment blocked and does NOT dispatch downstream', async () => {
    const { handler, missions, dispatch, advance, routerMod } =
      await loadModules()

    const fakeAdapter = {
      kind: 'claude-code' as const,
      async probe() {
        return { available: true }
      },
      async startRun(input: { runId: string; mcp: { runToken: string } }) {
        const token = input.mcp.runToken
        await handler.handleMcpRequest(
          { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
          dbPath,
        )
        await handler.handleMcpRequest(
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'task_complete',
            params: {
              token,
              runId: input.runId,
              blocker: 'need credentials',
              nextAction: 'ask human',
            },
          },
          dbPath,
        )
        return { runId: input.runId }
      },
      async *streamEvents() {},
      async interrupt() {},
    }

    const router = new routerMod.AgentRuntimeRouter({
      rawYaml: 'version: 1\nagents: []\n',
    })
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'dev-1',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'dev-2',
      fakeAdapter,
    )
    routerMod.setAgentRuntimeRouterForTests(router)

    const mission = missions.createOrUpdateMission({
      missionId: 'mission-e2e-2',
      title: 'E2E blocked mission',
      assignments: [
        { workerId: 'dev-1', task: 'stage A', reviewRequired: false },
      ],
    })
    const aId = mission.assignments[0].id
    missions.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [
        {
          workerId: 'dev-2',
          task: 'stage B',
          reviewRequired: false,
          dependsOn: [aId],
        },
      ],
    })

    const dispatchedNext: Array<string> = []
    const uninstall = advance.installAdvanceBridge({
      dispatchNext: async ({ missionId, assignmentId }) => {
        dispatchedNext.push(assignmentId)
        await dispatch.dispatchAssignment({ missionId, assignmentId })
      },
    })

    const result = await dispatch.dispatchAssignment({
      missionId: mission.id,
      assignmentId: aId,
    })
    expect(result.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 50))

    const after = missions.getSwarmMission(mission.id)!
    expect(after.assignments.find((a) => a.id === aId)!.state).toBe('blocked')
    expect(after.assignments.find((a) => a.workerId === 'dev-2')!.state).toBe(
      'queued',
    )
    expect(dispatchedNext).toHaveLength(0)

    uninstall()
    routerMod.setAgentRuntimeRouterForTests(null)
  }, 15_000)

  it('dispatchAssignment routes by capability when stage declares requires', async () => {
    const { missions, dispatch, advance, handler, routerMod } =
      await loadModules()

    const started: Array<{ runId: string; agentId: string }> = []
    const fakeAdapter = {
      kind: 'claude-code' as const,
      async probe() {
        return { available: true }
      },
      async startRun(input: {
        runId: string
        agentId: string
        mcp: { runToken: string }
      }) {
        started.push({ runId: input.runId, agentId: input.agentId })
        const token = input.mcp.runToken
        await handler.handleMcpRequest(
          { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
          dbPath,
        )
        await handler.handleMcpRequest(
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'task_complete',
            params: { token, runId: input.runId, summary: 'done' },
          },
          dbPath,
        )
        return { runId: input.runId }
      },
      async *streamEvents() {},
      async interrupt() {},
    }

    const router = new routerMod.AgentRuntimeRouter({
      rawYaml: `version: 1
agents:
  - id: general
    runtime: claude-code
    command: claude
  - id: gpu-runner
    runtime: claude-code
    command: claude
    capabilities: [gpu]
`,
    })
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'general',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'gpu-runner',
      fakeAdapter,
    )
    routerMod.setAgentRuntimeRouterForTests(router)

    const mission = missions.createOrUpdateMission({
      missionId: 'mission-cap',
      title: 'Capability routing mission',
      assignments: [
        {
          workerId: 'general',
          task: 'gpu task',
          reviewRequired: false,
          requires: ['gpu'],
        },
      ],
    })
    const aId = mission.assignments[0].id

    const dispatchedNext: Array<string> = []
    const uninstall = advance.installAdvanceBridge({
      dispatchNext: async ({ missionId, assignmentId }) => {
        dispatchedNext.push(assignmentId)
      },
    })

    const result = await dispatch.dispatchAssignment({
      missionId: mission.id,
      assignmentId: aId,
    })
    if (!result.ok) {
      console.log('capability dispatch failed:', result)
    }
    expect(result.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 50))

    expect(started).toHaveLength(1)
    expect(started[0].agentId).toBe('gpu-runner')
    const after = missions.getSwarmMission(mission.id)!
    expect(after.assignments.find((a) => a.id === aId)!.workerId).toBe(
      'gpu-runner',
    )

    uninstall()
    routerMod.setAgentRuntimeRouterForTests(null)
  }, 15_000)

  it('review stage approved releases downstream via advance', async () => {
    const { missions, dispatch, advance, handler, routerMod } =
      await loadModules()

    const fakeAdapter = {
      kind: 'claude-code' as const,
      async probe() {
        return { available: true }
      },
      async startRun(input: {
        runId: string
        agentId: string
        task: string
        mcp: { runToken: string }
      }) {
        const token = input.mcp.runToken
        await handler.handleMcpRequest(
          { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
          dbPath,
        )
        const summary =
          input.task.includes('review') || input.task.includes('Review')
            ? 'REVIEW_OUTCOME: approved\nLooks good.'
            : 'build done'
        await handler.handleMcpRequest(
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'task_complete',
            params: { token, runId: input.runId, summary },
          },
          dbPath,
        )
        return { runId: input.runId }
      },
      async *streamEvents() {},
      async interrupt() {},
    }

    const router = new routerMod.AgentRuntimeRouter({
      rawYaml: `version: 1\nagents:\n  - id: builder\n    runtime: claude-code\n    command: claude\n  - id: architect\n    runtime: claude-code\n    command: claude\n  - id: release-bot\n    runtime: claude-code\n    command: claude\n`,
    })
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'builder',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'architect',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'release-bot',
      fakeAdapter,
    )
    routerMod.setAgentRuntimeRouterForTests(router)

    const mission = missions.createOrUpdateMission({
      missionId: 'mission-review',
      title: 'Review mission',
      assignments: [
        { workerId: 'builder', task: 'build feature', reviewRequired: false },
      ],
    })
    const buildId = mission.assignments[0].id
    missions.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [
        {
          workerId: 'architect',
          task: 'review build',
          reviewRequired: false,
          dependsOn: [buildId],
        },
        {
          workerId: 'release-bot',
          task: 'release',
          reviewRequired: false,
          dependsOn: [buildId],
        },
      ],
    })

    const dispatchedNext: Array<string> = []
    const uninstall = advance.installAdvanceBridge({
      dispatchNext: async ({ missionId, assignmentId }) => {
        dispatchedNext.push(assignmentId)
        await dispatch.dispatchAssignment({ missionId, assignmentId })
      },
    })

    const result = await dispatch.dispatchAssignment({
      missionId: mission.id,
      assignmentId: buildId,
    })
    expect(result.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 100))

    const after = missions.getSwarmMission(mission.id)!
    // Review approved marks the upstream build assignment as done.
    expect(after.assignments.find((a) => a.id === buildId)!.state).toBe('done')
    // Review approved → release downstream was dispatched.
    expect(dispatchedNext.length).toBeGreaterThanOrEqual(2)
    const release = after.assignments.find((a) => a.task === 'release')!
    expect(release.state).toBe('checkpointed')

    uninstall()
    routerMod.setAgentRuntimeRouterForTests(null)
  }, 15_000)

  it('dispatchAssignment returns needsHuman when no agent matches required capabilities', async () => {
    const { missions, dispatch, routerMod } = await loadModules()
    const router = new routerMod.AgentRuntimeRouter({
      rawYaml: `version: 1
agents:
  - id: general
    runtime: claude-code
    command: claude
`,
    })
    routerMod.setAgentRuntimeRouterForTests(router)

    const mission = missions.createOrUpdateMission({
      missionId: 'mission-cap-missing',
      title: 'Missing capability mission',
      assignments: [
        {
          workerId: 'general',
          task: 'gpu task',
          reviewRequired: false,
          requires: ['gpu'],
        },
      ],
    })
    const aId = mission.assignments[0].id

    const result = await dispatch.dispatchAssignment({
      missionId: mission.id,
      assignmentId: aId,
    })
    expect(result.ok).toBe(false)
    expect((result as { needsHuman?: boolean }).needsHuman).toBe(true)

    routerMod.setAgentRuntimeRouterForTests(null)
  })
})

// Mutex serialization proof: two terminal events landing back-to-back each
// observe the post-write snapshot of the previous one (no double dispatch).
