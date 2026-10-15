/**
 * P2b fan-in convergence: after two parallel assignments complete,
 * advance detects the downstream dependsOn > 1, calls mergeSiblings with
 * the upstream head commits, then dispatches the downstream assignment.
 *
 * This is a semi-integration test: git-ops is mocked so we can assert the
 * advance routing logic without requiring per-assignment worktrees (which the
 * current per-mission worktree design does not yet support for true parallel
 * checkout). mergeSiblings itself is covered by git-ops.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string
let dbPath: string
let missionsDir: string

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'e2e-fanin-'))
  dbPath = join(tempRoot, 'collab.db')
  missionsDir = join(tempRoot, 'missions')

  vi.doMock('../git-ops', async () => {
    const actual = await vi.importActual('../git-ops')
    return {
      ...actual,
      mergeSiblings: vi.fn().mockResolvedValue({
        ok: true,
        conflicts: [],
        mergedHead: 'deadbeef00000000000000000000000000000000',
      }),
      ensureMissionWorktree: vi.fn().mockResolvedValue({
        ctx: { locality: 'local', cwd: '/tmp/mock-wt' },
        baseRef: 'base0000000000000000000000000000000000000',
        setupOutput: '',
      }),
      ensureRemoteMissionWorktree: vi.fn().mockResolvedValue({
        ctx: { locality: 'ssh', host: 'mock-host', cwd: '/tmp/mock-remote-wt' },
        setupOutput: '',
      }),
      pushBranchToRemote: vi.fn().mockResolvedValue(undefined),
    }
  })
  vi.doMock('../task-pipeline/projects', async () => {
    const actual = await vi.importActual('../task-pipeline/projects')
    return {
      ...actual,
      getProject: vi.fn().mockReturnValue({
        id: 'fanin-project',
        repo: '/tmp/mock-repo',
        defaultBranch: 'main',
        worktreeRoot: '/tmp/mock-worktrees',
        setup: [],
        maxConcurrentWorktrees: 5,
        gitRemote: '',
        selfHosted: false,
        remotes: [],
      }),
      assertServerNotInWorktreeRoot: vi.fn(),
    }
  })

  vi.doMock('../collab-db', async () => {
    const actual = await vi.importActual('../collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/collab-db', async () => {
    const actual = await vi.importActual('../../server/collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/swarm-environment', () => ({
    SWARM_CANONICAL_REPO: missionsDir,
    SWARM_MISSIONS_PATH: join(missionsDir, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
    SWARM_MEMORY_ROOT: join(tempRoot, 'memory-root'),
  }))
  vi.doMock('../swarm-environment', () => ({
    SWARM_CANONICAL_REPO: missionsDir,
    SWARM_MISSIONS_PATH: join(missionsDir, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
    SWARM_MEMORY_ROOT: join(tempRoot, 'memory-root'),
  }))

  const collabDb = await import('../../server/collab-db')
  const runTokens = await import('../../server/mcp/run-tokens')
  const handler = await import('../../server/mcp/mcp-handler')
  const missions = await import('../../server/swarm-missions')
  const dispatch = await import('../../server/agent-runtime/dispatch')
  const advance = await import('../../server/agent-runtime/advance')
  const routerMod = await import('../../server/agent-runtime/router')
  const gitOps = await import('../../server/git-ops')
  return {
    collabDb,
    runTokens,
    handler,
    missions,
    dispatch,
    advance,
    routerMod,
    gitOps,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../collab-db')
  vi.doUnmock('../../server/collab-db')
  vi.doUnmock('../swarm-environment')
  vi.doUnmock('../../server/swarm-environment')
  vi.doUnmock('../git-ops')
  vi.doUnmock('../task-pipeline/projects')
  vi.restoreAllMocks()
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('P2b fan-in merge routing', () => {
  it('advance calls mergeSiblings and dispatches downstream on fan-in', async () => {
    const { handler, missions, dispatch, advance, routerMod, gitOps } =
      await loadModules()

    const router = new routerMod.AgentRuntimeRouter({
      rawYaml: `version: 1\nagents:\n  - id: dev-1\n    runtime: claude-code\n    command: claude\n  - id: dev-2\n    runtime: claude-code\n    command: claude\n  - id: reviewer\n    runtime: claude-code\n    command: claude\n`,
    })

    const dispatchedNext: Array<string> = []
    const fakeAdapter = {
      kind: 'claude-code' as const,
      async probe() {
        return { available: true }
      },
      async startRun(input: {
        runId: string
        agentId: string
        task: string
        cwd: string
        mcp: { runToken: string }
      }) {
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
              summary: `${input.agentId} done`,
              headSha: `head-${input.agentId}`,
            },
          },
          dbPath,
        )
        return { runId: input.runId }
      },
      async *streamEvents() {
        /* empty */
      },
      async interrupt() {
        /* noop */
      },
    }
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'dev-1',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'dev-2',
      fakeAdapter,
    )
    ;(router as never as { adapters: Map<string, unknown> }).adapters.set(
      'reviewer',
      fakeAdapter,
    )
    routerMod.setAgentRuntimeRouterForTests(router)

    const mission = missions.createOrUpdateMission({
      missionId: 'mission-fanin',
      title: 'Fan-in mission',
      projectId: 'fanin-project',
      workspaceMode: 'worktree',
      assignments: [
        { workerId: 'dev-1', task: 'A work', reviewRequired: false },
        { workerId: 'dev-2', task: 'B work', reviewRequired: false },
      ],
    })

    const aId = mission.assignments[0].id
    const bId = mission.assignments[1].id
    const updated = missions.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [
        {
          workerId: 'reviewer',
          task: 'Review combined',
          reviewRequired: false,
          dependsOn: [aId, bId],
        },
      ],
    })
    const aC = updated.assignments.find((a) => a.workerId === 'reviewer')!

    // Persist upstream baseRef/headSha so advance sees them after re-reading
    // the mission store.
    missions.setAssignmentBaseRef(
      mission.id,
      aId,
      'base0000000000000000000000000000000000000',
    )
    missions.setAssignmentHeadSha(
      mission.id,
      aId,
      'aaaa000000000000000000000000000000000000',
    )
    missions.setAssignmentBaseRef(
      mission.id,
      bId,
      'base0000000000000000000000000000000000000',
    )
    missions.setAssignmentHeadSha(
      mission.id,
      bId,
      'bbbb000000000000000000000000000000000000',
    )

    const refreshed = missions.getSwarmMission(mission.id)!
    const uninstall = advance.installAdvanceBridge({
      dispatchNext: async ({ missionId, assignmentId }) => {
        dispatchedNext.push(assignmentId)
        await dispatch.dispatchAssignment({ missionId, assignmentId })
      },
    })

    // Kick off sibling A; the fake adapter completes synchronously, so advance
    // will auto-dispatch B, then after B completes it will merge and dispatch
    // the downstream reviewer.
    const ar = await dispatch.dispatchAssignment({
      missionId: mission.id,
      assignmentId: aId,
    })
    expect(ar.ok).toBe(true)

    await new Promise((r) => setTimeout(r, 100))
    const after = missions.getSwarmMission(mission.id)!
    expect(after.assignments[0].state).toBe('checkpointed')
    expect(after.assignments[1].state).toBe('checkpointed')

    // Downstream reviewer was auto-dispatched after the fan-in merge.
    expect(dispatchedNext).toContain(aC.id)
    const downstream = after.assignments.find((a) => a.id === aC.id)!
    expect(downstream.state).toBe('checkpointed')
    expect(downstream.baseRef).toBe('deadbeef00000000000000000000000000000000')

    expect(gitOps.mergeSiblings).toHaveBeenCalledTimes(1)
    const calledHeads = (gitOps.mergeSiblings as ReturnType<typeof vi.fn>).mock
      .calls[0][2]
    expect(calledHeads).toEqual(
      expect.arrayContaining([
        'aaaa000000000000000000000000000000000000',
        'bbbb000000000000000000000000000000000000',
      ]),
    )

    uninstall()
    routerMod.setAgentRuntimeRouterForTests(null)
  }, 15_000)
})
