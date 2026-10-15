import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string
let dbPath: string

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'mcp-tools-test-'))
  dbPath = join(tempRoot, 'collab.db')
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
  const { issueRunToken } = await import('../../server/mcp/run-tokens')
  const { handleMcpRequest } = await import('../../server/mcp/mcp-handler')
  const { createOrUpdateMission, recordMissionCheckpoint } =
    await import('../../server/swarm-missions')
  const { runSqlite } = await import('../../server/sqlite-helper')
  return {
    issueRunToken,
    handleMcpRequest,
    createOrUpdateMission,
    recordMissionCheckpoint,
    runSqlite,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../collab-db')
  vi.doUnmock('../../server/collab-db')
  vi.doUnmock('../../server/swarm-environment')
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function setup(
  mods: Awaited<ReturnType<typeof loadModules>>,
  suffix: string,
) {
  const mission = mods.createOrUpdateMission({
    missionId: `mission-tools-${suffix}`,
    title: 'tools test',
    assignments: [{ workerId: 'dev-1', task: 'work', reviewRequired: false }],
  })
  const assignmentId = mission.assignments[0].id
  const { token } = mods.issueRunToken({
    kind: 'run_write',
    runId: `run-${suffix}`,
    participantId: 'dev-1',
    assignmentId,
    taskId: mission.id,
    roomId: 'room-1',
    toolAllowlist: [
      'task_get',
      'task_start',
      'task_complete',
      'kanban_get',
      'review_approve',
      'review_request_changes',
      'message_send',
      'member_work_sync_status',
      'member_work_sync_report',
    ],
    dbPath,
  })
  return { mission, assignmentId, token }
}

describe('mcp tool groups (P1.4)', () => {
  it('kanban_get returns cards for read allowed token', async () => {
    const mods = await loadModules()
    const { token } = await setup(mods, 'k1')
    const res = await mods.handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'kanban_get', params: { token } },
      dbPath,
    )
    expect(res.error).toBeUndefined()
    expect((res.result as { cards: Array<unknown> }).cards).toBeDefined()
  })

  it('message_send writes a room_messages row', async () => {
    const mods = await loadModules()
    const { token } = await setup(mods, 'm1')
    const res = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'message_send',
        params: { token, content: 'hello room', mentions: [] },
      },
      dbPath,
    )
    expect(res.error).toBeUndefined()
    const rows = JSON.parse(
      mods.runSqlite(
        dbPath,
        "SELECT * FROM room_messages WHERE room_id = 'room-1'",
      ),
    ) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('hello room')
    expect(rows[0].sender_participant_id).toBe('dev-1')
  })

  it('message_send rejects roomId conflicting with token scope', async () => {
    const mods = await loadModules()
    const { token } = await setup(mods, 'm2')
    const res = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'message_send',
        params: { token, roomId: 'room-OTHER', content: 'x' },
      },
      dbPath,
    )
    expect(res.error?.code).toBe(-32006)
  })

  it('review_approve marks a checkpointed assignment done', async () => {
    const mods = await loadModules()
    const { mission, assignmentId, token } = await setup(mods, 'r1')
    // Put the assignment into checkpointed state.
    mods.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId,
      workerId: 'dev-1',
      checkpoint: {
        stateLabel: 'DONE',
        checkpointStatus: 'done',
        runtimeState: 'idle',
        filesChanged: null,
        commandsRun: null,
        result: 'done work',
        blocker: null,
        nextAction: null,
        reviewOutcome: null,
        raw: 'done work',
      },
      source: 'test',
    })
    const res = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'review_approve',
        params: { token, assignmentId },
      },
      dbPath,
    )
    expect(res.error).toBeUndefined()
    expect((res.result as { outcome: string }).outcome).toBe('approved')
    const after = mods.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [],
    })
    expect(after.assignments.find((a) => a.id === assignmentId)?.state).toBe(
      'done',
    )
  })

  it('review_request_changes flips assignment to blocked with feedback', async () => {
    const mods = await loadModules()
    const { mission, assignmentId, token } = await setup(mods, 'r2')
    mods.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId,
      workerId: 'dev-1',
      checkpoint: {
        stateLabel: 'DONE',
        checkpointStatus: 'done',
        runtimeState: 'idle',
        filesChanged: null,
        commandsRun: null,
        result: 'work',
        blocker: null,
        nextAction: null,
        reviewOutcome: null,
        raw: 'work',
      },
      source: 'test',
    })
    const res = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'review_request_changes',
        params: { token, assignmentId, feedback: 'missing tests' },
      },
      dbPath,
    )
    expect(res.error).toBeUndefined()
    expect((res.result as { outcome: string }).outcome).toBe(
      'changes_requested',
    )
    const after = mods.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [],
    })
    const a = after.assignments.find((x) => x.id === assignmentId)!
    expect(a.state).toBe('blocked')
    expect(a.checkpoint?.blocker).toContain('missing tests')
  })

  it('sync: status → report happy path; report never completes the task', async () => {
    const mods = await loadModules()
    const { mission, assignmentId, token } = await setup(mods, 's1')

    const status = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'member_work_sync_status',
        params: { token },
      },
      dbPath,
    )
    expect(status.error).toBeUndefined()
    const { agendaFingerprint, reportToken } = status.result as {
      agendaFingerprint: string
      reportToken: string
    }
    expect(agendaFingerprint).toBeTruthy()
    expect(reportToken).toMatch(/^rpt_/)

    const report = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'member_work_sync_report',
        params: { token, state: 'on_track', agendaFingerprint, reportToken },
      },
      dbPath,
    )
    expect(report.error).toBeUndefined()
    expect((report.result as { acknowledged: boolean }).acknowledged).toBe(true)

    // 永不关单: assignment state untouched.
    const after = mods.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [],
    })
    expect(after.assignments.find((a) => a.id === assignmentId)?.state).toBe(
      'queued',
    )
  })

  it('sync report: same token + same payload replays first response (idempotent)', async () => {
    const mods = await loadModules()
    const { token } = await setup(mods, 's2')
    const status = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'member_work_sync_status',
        params: { token },
      },
      dbPath,
    )
    const { agendaFingerprint, reportToken } = status.result as {
      agendaFingerprint: string
      reportToken: string
    }

    const first = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'member_work_sync_report',
        params: { token, state: 'on_track', agendaFingerprint, reportToken },
      },
      dbPath,
    )
    expect(first.error).toBeUndefined()

    const retry = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'member_work_sync_report',
        params: { token, state: 'on_track', agendaFingerprint, reportToken },
      },
      dbPath,
    )
    expect(retry.error).toBeUndefined()
    expect((retry.result as { replayed?: boolean }).replayed).toBe(true)
  })

  it('sync report: same token + different payload rejected', async () => {
    const mods = await loadModules()
    const { token } = await setup(mods, 's3')
    const status = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'member_work_sync_status',
        params: { token },
      },
      dbPath,
    )
    const { agendaFingerprint, reportToken } = status.result as {
      agendaFingerprint: string
      reportToken: string
    }

    await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'member_work_sync_report',
        params: { token, state: 'on_track', agendaFingerprint, reportToken },
      },
      dbPath,
    )

    const evil = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'member_work_sync_report',
        params: { token, state: 'idle', agendaFingerprint, reportToken },
      },
      dbPath,
    )
    expect(evil.error).toBeDefined()
    expect(evil.error?.code).toBe(-32003)
    expect(evil.error?.message).toMatch(/different payload/)
  })

  it('sync report: stale fingerprint rejected with nextRequiredToolCall', async () => {
    const mods = await loadModules()
    const { mission, token } = await setup(mods, 's4')
    const status = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'member_work_sync_status',
        params: { token },
      },
      dbPath,
    )
    const { reportToken } = status.result as { reportToken: string }

    // Mutate the agenda (add an assignment) so the fingerprint goes stale.
    mods.createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [
        { workerId: 'dev-2', task: 'new stage', reviewRequired: false },
      ],
    })

    const res = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 15,
        method: 'member_work_sync_report',
        params: {
          token,
          state: 'on_track',
          agendaFingerprint: 'stale-fp',
          reportToken,
        },
      },
      dbPath,
    )
    expect(res.error).toBeDefined()
    expect(res.error?.message).toMatch(/stale/)
    const data = res.error?.data as { nextRequiredToolCall?: { tool: string } }
    expect(data.nextRequiredToolCall?.tool).toBe('member_work_sync_status')
  })

  it('read_only token can call kanban_get + sync_status but not sync_report', async () => {
    const mods = await loadModules()
    const mission = mods.createOrUpdateMission({
      missionId: 'mission-tools-ro',
      title: 'ro test',
      assignments: [{ workerId: 'dev-1', task: 'work', reviewRequired: false }],
    })
    const { token } = mods.issueRunToken({
      kind: 'read_only',
      runId: 'run-ro',
      participantId: 'dev-1',
      assignmentId: mission.assignments[0].id,
      taskId: mission.id,
      toolAllowlist: ['kanban_get', 'task_get', 'member_work_sync_status'],
      dbPath,
    })

    const kb = await mods.handleMcpRequest(
      { jsonrpc: '2.0', id: 16, method: 'kanban_get', params: { token } },
      dbPath,
    )
    expect(kb.error).toBeUndefined()

    const st = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 17,
        method: 'member_work_sync_status',
        params: { token },
      },
      dbPath,
    )
    expect(st.error).toBeUndefined()

    const rp = await mods.handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 18,
        method: 'member_work_sync_report',
        params: {
          token,
          state: 'on_track',
          agendaFingerprint: 'x',
          reportToken: 'y',
        },
      },
      dbPath,
    )
    expect(rp.error?.code).toBe(-32003)
    expect(rp.error?.message).toMatch(/run_write/)
  })
})
