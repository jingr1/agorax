/**
 * P2a reconcile disposition matrix + concurrent fan-in test (plan 行 475:
 * «并发 fan-in——两个上游 checkpoint 同时到达，断言下游只被派发一次»).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string
let dbPath: string

let prevHermesHome: string | undefined
let prevCollabDb: string | undefined

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'reconcile-test-'))
  dbPath = join(tempRoot, 'collab.db')
  prevHermesHome = process.env.HERMES_HOME
  prevCollabDb = process.env.HERMES_COLLAB_DB
  // pid-registry + collab writers must land under /tmp, not ~/.hermes
  // (sandbox / live gateway make that tree read-only).
  process.env.HERMES_HOME = tempRoot
  process.env.HERMES_COLLAB_DB = dbPath
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
  const missions = await import('../../server/swarm-missions')
  const taskRuns = await import('../../server/mcp/task-runs')
  const runTokens = await import('../../server/mcp/run-tokens')
  const pidRegistry = await import('../../server/agent-runtime/pid-registry')
  const reconcile = await import('../../server/task-pipeline/reconcile')
  const { runSqlite } = await import('../../server/sqlite-helper')
  return { missions, taskRuns, runTokens, pidRegistry, reconcile, runSqlite }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../collab-db')
  vi.doUnmock('../../server/collab-db')
  vi.doUnmock('../../server/swarm-environment')
  if (prevHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = prevHermesHome
  if (prevCollabDb === undefined) delete process.env.HERMES_COLLAB_DB
  else process.env.HERMES_COLLAB_DB = prevCollabDb
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function setupMission(
  mods: Awaited<ReturnType<typeof loadModules>>,
  id: string,
) {
  const mission = mods.missions.createOrUpdateMission({
    missionId: id,
    title: id,
    assignments: [{ workerId: 'dev-1', task: 'work', reviewRequired: false }],
  })
  return { mission, assignmentId: mission.assignments[0].id }
}

function markDispatched(
  mods: Awaited<ReturnType<typeof loadModules>>,
  missionId: string,
  assignmentId: string,
) {
  const m = mods.missions.getSwarmMission(missionId)!
  const a = m.assignments.find((x) => x.id === assignmentId)!
  mods.missions.markMissionAssignmentDispatched({
    missionId,
    workerId: a.workerId,
    task: a.task,
  })
}

describe('P2a reconcileOnBoot', () => {
  it('crash_orphan: running row + queued assignment → run failed, pending_turn opened, no requeue', async () => {
    const mods = await loadModules()
    const { mission, assignmentId } = setupMission(mods, 'm-orphan')
    // Never dispatched (assignment stays queued), but a running row exists.
    mods.taskRuns.startTaskRun({
      runId: 'run-orphan',
      taskId: mission.id,
      missionId: mission.id,
      assignmentId,
      agentId: 'dev-1',
      runtime: 'claude-code',
      dbPath,
    })
    mods.runTokens.issueRunToken({
      kind: 'run_write',
      runId: 'run-orphan',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_complete'],
      dbPath,
    })

    const report = mods.reconcile.reconcileOnBoot({ dbPath })
    expect(report.findings.map((f) => f.kind)).toContain('crash_orphan')

    // Run failed + token revoked.
    expect(mods.taskRuns.getTaskRun('run-orphan', dbPath)?.status).toBe(
      'failed',
    )
    // Assignment NOT requeued (still queued — but CAS dispatch is blocked by
    // the pending_turn, which is the human gate).
    const pending = JSON.parse(
      mods.runSqlite(
        dbPath,
        "SELECT * FROM pending_turns WHERE assignment_id = '" +
          assignmentId +
          "'",
      ),
    ) as Array<Record<string, unknown>>
    expect(pending).toHaveLength(1)
    expect(pending[0].kind).toBe('blocked')
  })

  it('dispatch_incomplete: dispatched assignment + no run row → requeued to queued', async () => {
    const mods = await loadModules()
    const { mission, assignmentId } = setupMission(mods, 'm-incomplete')
    markDispatched(mods, mission.id, assignmentId)
    expect(
      mods.missions.getSwarmMission(mission.id)!.assignments[0].state,
    ).toBe('dispatched')

    const report = mods.reconcile.reconcileOnBoot({ dbPath })
    expect(report.findings.map((f) => f.kind)).toContain('dispatch_incomplete')
    expect(
      mods.missions.getSwarmMission(mission.id)!.assignments[0].state,
    ).toBe('queued')
  })

  it('process_dead: running row + dispatched + dead pid → run failed, assignment blocked, NOT requeued', async () => {
    const mods = await loadModules()
    const { mission, assignmentId } = setupMission(mods, 'm-dead')
    markDispatched(mods, mission.id, assignmentId)
    mods.taskRuns.startTaskRun({
      runId: 'run-dead',
      taskId: mission.id,
      missionId: mission.id,
      assignmentId,
      agentId: 'dev-1',
      runtime: 'claude-code',
      dbPath,
    })
    // pid that is definitely dead
    mods.pidRegistry.registerPid({
      runId: 'run-dead',
      agentId: 'dev-1',
      pid: 999999,
      runtime: 'claude-code',
      startedAt: 1,
      logPath: '/x',
    })

    const report = mods.reconcile.reconcileOnBoot({ dbPath })
    expect(report.findings.map((f) => f.kind)).toContain('process_dead')
    expect(mods.taskRuns.getTaskRun('run-dead', dbPath)?.status).toBe('failed')
    expect(
      mods.missions.getSwarmMission(mission.id)!.assignments[0].state,
    ).toBe('blocked')
    expect(mods.pidRegistry.lookupPid('run-dead')).toBeNull()
  })

  it('reattached: running row + dispatched + live pid → no state change', async () => {
    const mods = await loadModules()
    const { mission, assignmentId } = setupMission(mods, 'm-live')
    markDispatched(mods, mission.id, assignmentId)
    mods.taskRuns.startTaskRun({
      runId: 'run-live',
      taskId: mission.id,
      missionId: mission.id,
      assignmentId,
      agentId: 'dev-1',
      runtime: 'claude-code',
      dbPath,
    })
    const child = spawn('sleep', ['30'], { detached: true })
    child.unref()
    const pid = child.pid!
    mods.pidRegistry.registerPid({
      runId: 'run-live',
      agentId: 'dev-1',
      pid,
      runtime: 'claude-code',
      startedAt: 1,
      logPath: '/x',
    })

    try {
      const report = mods.reconcile.reconcileOnBoot({ dbPath })
      expect(report.findings.map((f) => f.kind)).toContain('reattached')
      // Nothing changed.
      expect(mods.taskRuns.getTaskRun('run-live', dbPath)?.status).toBe(
        'running',
      )
      expect(
        mods.missions.getSwarmMission(mission.id)!.assignments[0].state,
      ).toBe('dispatched')
      expect(mods.pidRegistry.lookupPid('run-live')?.pid).toBe(pid)
    } finally {
      mods.pidRegistry.killProcessGroup(pid, 'SIGKILL')
    }
  })
})

describe('P2a concurrent fan-in (plan 行 475)', () => {
  it('two upstream checkpoints arriving together dispatch the downstream exactly once', async () => {
    const mods = await loadModules()
    const advance = await import('../../server/agent-runtime/advance')

    // Diamond: A and B both feed C. C must dispatch exactly once even when
    // both A.done and B.done land through the MCP bridge back-to-back.
    const mission = mods.missions.createOrUpdateMission({
      missionId: 'm-fanin',
      title: 'fan-in',
      assignments: [
        { workerId: 'dev-a', task: 'A', reviewRequired: false },
        { workerId: 'dev-b', task: 'B', reviewRequired: false },
      ],
    })
    const aId = mission.assignments.find((a) => a.workerId === 'dev-a')!.id
    const bId = mission.assignments.find((a) => a.workerId === 'dev-b')!.id
    mods.missions.appendMissionContinuation({
      missionId: mission.id,
      workerId: 'dev-c',
      task: 'C',
      rationale: 'r',
      dependsOn: [aId, bId],
    })
    const cId = mods.missions
      .getSwarmMission(mission.id)!
      .assignments.find((a) => a.workerId === 'dev-c')!.id

    const dispatched: Array<string> = []
    const uninstall = advance.installAdvanceBridge({
      dispatchNext: ({ assignmentId }) => {
        dispatched.push(assignmentId)
        const m = mods.missions.getSwarmMission(mission.id)!
        const a = m.assignments.find((x) => x.id === assignmentId)!
        mods.missions.markMissionAssignmentDispatched({
          missionId: mission.id,
          workerId: a.workerId,
          task: a.task,
        })
      },
    })

    // Drive both terminal events through the real MCP task_complete path.
    const { handleMcpRequest } = await import('../../server/mcp/mcp-handler')
    async function completeRun(
      workerId: string,
      assignmentId: string,
      runId: string,
    ) {
      mods.taskRuns.startTaskRun({
        runId,
        taskId: mission.id,
        missionId: mission.id,
        assignmentId,
        agentId: workerId,
        runtime: 'claude-code',
        dbPath,
      })
      const { token } = mods.runTokens.issueRunToken({
        kind: 'run_write',
        runId,
        participantId: workerId,
        assignmentId,
        taskId: mission.id,
        toolAllowlist: ['task_start', 'task_complete'],
        dbPath,
      })
      await handleMcpRequest(
        { jsonrpc: '2.0', id: runId, method: 'task_start', params: { token } },
        dbPath,
      )
      await handleMcpRequest(
        {
          jsonrpc: '2.0',
          id: `${runId}-c`,
          method: 'task_complete',
          params: { token, runId, summary: `${workerId} done` },
        },
        dbPath,
      )
    }

    // Back-to-back: both completions enqueue before the event loop drains.
    await Promise.all([
      completeRun('dev-a', aId, 'run-a'),
      completeRun('dev-b', bId, 'run-b'),
    ])
    // Flush the advance queue (microtasks + one macrotask).
    await new Promise((r) => setTimeout(r, 100))

    uninstall()
    expect(dispatched.filter((x) => x === cId)).toHaveLength(1)
    const final = mods.missions.getSwarmMission(mission.id)!
    expect(final.assignments.find((a) => a.id === cId)!.state).toBe(
      'dispatched',
    )
  })
})
