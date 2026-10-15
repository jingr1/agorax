import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string
let dbPath: string

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'mcp-test-'))
  dbPath = join(tempRoot, 'collab.db')
  vi.doMock('../collab-db', async () => {
    const actual = await vi.importActual('../collab-db')
    return {
      ...actual,
      getCollabDbPath: () => dbPath,
    }
  })
  vi.doMock('../../server/collab-db', async () => {
    const actual = await vi.importActual('../../server/collab-db')
    return {
      ...actual,
      getCollabDbPath: () => dbPath,
    }
  })
  const {
    issueRunToken,
    revokeRunToken,
    revokeRunTokensForRun,
    resolveRunToken,
  } = await import('../../server/mcp/run-tokens')
  const { handleMcpRequest } = await import('../../server/mcp/mcp-handler')
  const { createOrUpdateMission } = await import('../../server/swarm-missions')
  const { startTaskRun, getTaskRun } =
    await import('../../server/mcp/task-runs')
  return {
    issueRunToken,
    revokeRunToken,
    revokeRunTokensForRun,
    resolveRunToken,
    handleMcpRequest,
    createOrUpdateMission,
    startTaskRun,
    getTaskRun,
  }
}

describe('mcp-handler', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'mcp-test-'))
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../collab-db')
    vi.doUnmock('../../server/collab-db')
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  async function setupMission(missionId: string) {
    const { createOrUpdateMission } = await loadModules()
    const mission = createOrUpdateMission({
      missionId,
      title: `Mission ${missionId}`,
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    return { mission, assignmentId: mission.assignments[0].id }
  }

  it('task_get returns assignment and nextRequiredToolCall for valid token', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-1',
      title: 'MCP test mission',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-1',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get', 'task_start', 'task_complete'],
      dbPath,
    })

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'task_get',
        params: { token },
      },
      dbPath,
    )

    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({
      missionId: mission.id,
      assignment: { id: assignmentId, workerId: 'dev-1', state: 'queued' },
      nextRequiredToolCall: { tool: 'task_start' },
    })
  })

  it('task_start creates run with token.runId and succeeds', async () => {
    const {
      issueRunToken,
      handleMcpRequest,
      createOrUpdateMission,
      getTaskRun,
    } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-2a',
      title: 'MCP start test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-2a',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get', 'task_start', 'task_complete'],
      dbPath,
    })

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'task_start',
        params: { token },
      },
      dbPath,
    )

    expect(response.error).toBeUndefined()
    const result = response.result as {
      runId: string
      status: string
      nextRequiredToolCall?: { tool: string }
    }
    expect(result.runId).toBe('run-2a')
    expect(result.status).toBe('running')
    expect(result.nextRequiredToolCall?.tool).toBe('task_complete')

    const run = getTaskRun('run-2a', dbPath)
    expect(run).not.toBeNull()
    expect(run?.status).toBe('running')
    expect(run?.agentId).toBe('dev-1')
  })

  it('task_start duplicate (same token) is rejected as idempotent conflict', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-2b',
      title: 'MCP duplicate start test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-2b',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_start', 'task_complete'],
      dbPath,
    })

    const first = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
      dbPath,
    )
    expect(first.error).toBeUndefined()

    const second = await handleMcpRequest(
      { jsonrpc: '2.0', id: 2, method: 'task_start', params: { token } },
      dbPath,
    )
    expect(second.error).toBeDefined()
    expect(second.error?.code).toBe(-32602) // INVALID_PARAMS — run already started
  })

  it('task_start rejects non-owner token', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-2',
      title: 'MCP ownership test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-2',
      participantId: 'dev-2', // different worker
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get', 'task_start', 'task_complete'],
      dbPath,
    })

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'task_start',
        params: { token },
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32006) // OWNERSHIP_MISMATCH
  })

  it('task_complete marks run done and revokes token (subsequent calls 403)', async () => {
    const {
      issueRunToken,
      resolveRunToken,
      handleMcpRequest,
      createOrUpdateMission,
    } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-3',
      title: 'MCP complete test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-3',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get', 'task_start', 'task_complete'],
      dbPath,
    })

    const startRes = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'task_start',
        params: { token },
      },
      dbPath,
    )
    expect(startRes.error).toBeUndefined()

    const completeRes = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'task_complete',
        params: { token, runId: 'run-3', summary: 'Done' },
      },
      dbPath,
    )
    expect(completeRes.error).toBeUndefined()
    expect((completeRes.result as { status: string }).status).toBe('done')

    // Token revoked on completion: any further call is rejected.
    expect(resolveRunToken(token, dbPath)).toBeNull()
    const after = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'task_get',
        params: { token },
      },
      dbPath,
    )
    expect(after.error).toBeDefined()
    expect(after.error?.code).toBe(-32005) // TOKEN_REVOKED
  })

  it('task_complete with blocker yields blocked status', async () => {
    const {
      issueRunToken,
      handleMcpRequest,
      createOrUpdateMission,
      getTaskRun,
    } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-3b',
      title: 'MCP blocked test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-3b',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_start', 'task_complete'],
      dbPath,
    })

    await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
      dbPath,
    )
    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'task_complete',
        params: {
          token,
          runId: 'run-3b',
          blocker: 'waiting on review',
          nextAction: 'ping architect',
        },
      },
      dbPath,
    )
    expect(res.error).toBeUndefined()
    expect((res.result as { status: string }).status).toBe('blocked')
    expect(getTaskRun('run-3b', dbPath)?.status).toBe('blocked')
  })

  it('task_complete with explicit status needs_input', async () => {
    const {
      issueRunToken,
      handleMcpRequest,
      createOrUpdateMission,
      getTaskRun,
    } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-3c',
      title: 'MCP needs_input test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-3c',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_start', 'task_complete'],
      dbPath,
    })

    await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
      dbPath,
    )
    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'task_complete',
        params: {
          token,
          runId: 'run-3c',
          status: 'needs_input',
          summary: 'need human decision',
        },
      },
      dbPath,
    )
    expect(res.error).toBeUndefined()
    expect(getTaskRun('run-3c', dbPath)?.status).toBe('needs_input')
  })

  it('task_complete rejects mismatched runId (confused-agent guard)', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-3d',
      title: 'MCP runId mismatch test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-3d',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_start', 'task_complete'],
      dbPath,
    })

    await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'task_start', params: { token } },
      dbPath,
    )
    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'task_complete',
        params: { token, runId: 'run-OTHER', summary: 'wrong run' },
      },
      dbPath,
    )
    expect(res.error).toBeDefined()
    expect(res.error?.code).toBe(-32006) // OWNERSHIP_MISMATCH
  })

  it('rejects params.scope mismatch (assignmentId / taskId) with OWNERSHIP_MISMATCH', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-3e',
      title: 'MCP scope mismatch test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-3e',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get', 'task_start'],
      dbPath,
    })

    const badAssignment = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'task_get',
        params: { token, assignmentId: 'asg_OTHER' },
      },
      dbPath,
    )
    expect(badAssignment.error?.code).toBe(-32006)

    const badTask = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'task_get',
        params: { token, taskId: 'mission_OTHER' },
      },
      dbPath,
    )
    expect(badTask.error?.code).toBe(-32006)
  })

  it('rejects revoked token with TOKEN_REVOKED (-32005)', async () => {
    const {
      issueRunToken,
      revokeRunToken,
      handleMcpRequest,
      createOrUpdateMission,
    } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-4',
      title: 'MCP revoke test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token, tokenHash } = issueRunToken({
      kind: 'run_write',
      runId: 'run-4',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get'],
      dbPath,
    })

    revokeRunToken(tokenHash, dbPath)

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'task_get',
        params: { token },
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32005) // TOKEN_REVOKED
  })

  it('rejects expired token with TOKEN_EXPIRED (-32004)', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-4b',
      title: 'MCP expiry test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-4b',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get'],
      ttlMs: -1000, // already expired
      dbPath,
    })

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'task_get',
        params: { token },
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32004) // TOKEN_EXPIRED
  })

  it('rejects invalid token with FORBIDDEN (-32003)', async () => {
    const { handleMcpRequest } = await loadModules()

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'task_get',
        params: { token: 'mcp_rw_deadbeefdeadbeefdeadbeefdeadbeef' },
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32003) // FORBIDDEN
  })

  it('server restart: token persists in db and resolves after re-open', async () => {
    const { issueRunToken, createOrUpdateMission } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-5',
      title: 'MCP restart test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'run_write',
      runId: 'run-5',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get'],
      dbPath,
    })

    // Simulate server restart: fresh module load, same dbPath
    vi.resetModules()
    const { resolveRunToken: resolveAfterRestart } =
      await import('../../server/mcp/run-tokens')
    const resolved = resolveAfterRestart(token, dbPath)
    expect(resolved).not.toBeNull()
    expect(resolved?.runId).toBe('run-5')
    expect(resolved?.participantId).toBe('dev-1')
  })

  it('re-dispatch revokes old token and rejects it with TOKEN_REVOKED', async () => {
    const {
      issueRunToken,
      revokeRunTokensForRun,
      handleMcpRequest,
      createOrUpdateMission,
    } = await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-6',
      title: 'MCP re-dispatch test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    // First dispatch
    const first = issueRunToken({
      kind: 'run_write',
      runId: 'run-6a',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get'],
      dbPath,
    })

    // Re-dispatch: revoke old run's tokens before issuing the new attempt's
    revokeRunTokensForRun('run-6a', dbPath)

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'task_get',
        params: { token: first.token },
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32005) // TOKEN_REVOKED
  })

  it('issueRunToken refuses read_only token carrying write tools', async () => {
    const { issueRunToken } = await loadModules()

    expect(() =>
      issueRunToken({
        kind: 'read_only',
        runId: 'run-7',
        participantId: 'dev-1',
        assignmentId: 'asg-x',
        taskId: 'mission-x',
        toolAllowlist: ['task_get', 'task_start'],
        dbPath,
      }),
    ).toThrow(/read_only/)
  })

  it('read_only token is rejected from write tools with FORBIDDEN', async () => {
    const { issueRunToken, handleMcpRequest, createOrUpdateMission } =
      await loadModules()

    const mission = createOrUpdateMission({
      missionId: 'mission-mcp-7',
      title: 'MCP read_only test',
      assignments: [
        {
          workerId: 'dev-1',
          task: 'Implement MCP handler',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0].id

    const { token } = issueRunToken({
      kind: 'read_only',
      runId: 'run-7',
      participantId: 'dev-1',
      assignmentId,
      taskId: mission.id,
      toolAllowlist: ['task_get'],
      dbPath,
    })

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'task_start',
        params: { token },
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32003) // FORBIDDEN
    expect(response.error?.message).toContain('run_write')
  })

  it('rejects non-string method with INVALID_REQUEST', async () => {
    const { handleMcpRequest } = await loadModules()

    const response = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 99,
        method: 123 as unknown as string,
        params: {},
      },
      dbPath,
    )

    expect(response.error).toBeDefined()
    expect(response.error?.code).toBe(-32600) // INVALID_REQUEST
  })
})
