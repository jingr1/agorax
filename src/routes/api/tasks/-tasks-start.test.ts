/** @vitest-environment node */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Route handlers import task-service, which pulls in the runtime subtree;
// first load can exceed the default 5s timeout.
vi.setConfig({ testTimeout: 30_000 })

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => opts,
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

let tmpHome = ''
let originalCwd = ''

function writeSwarmMissions(missions: Array<Record<string, unknown>>) {
  const runtimePath = path.join(tmpHome, '.runtime')
  fs.mkdirSync(runtimePath, { recursive: true })
  fs.writeFileSync(
    path.join(runtimePath, 'swarm-missions.json'),
    JSON.stringify({ version: 1, missions }, null, 2) + '\n',
    'utf-8',
  )
}

function writeKanbanCards(cards: Array<Record<string, unknown>>) {
  fs.mkdirSync(tmpHome, { recursive: true })
  fs.writeFileSync(
    path.join(tmpHome, 'swarm2-kanban.json'),
    JSON.stringify({ cards }, null, 2) + '\n',
    'utf-8',
  )
}

async function makeTaskIdHandlers() {
  const mod = await import('./$taskId')
  return (mod as any).Route.server.handlers
}

beforeEach(() => {
  originalCwd = process.cwd()
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-start-route-test-'))
  process.chdir(tmpHome)
  vi.stubEnv('HERMES_HOME', tmpHome)
  vi.stubEnv('CLAUDE_KANBAN_BACKEND', 'local')
  vi.resetModules()
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('POST /api/tasks/:taskId/start', () => {
  it('dispatches ready assignments and returns summary', async () => {
    writeSwarmMissions([
      {
        id: 'mission-123',
        title: 'Test mission',
        state: 'planning',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pipelineId: 'default-build',
        taskId: 'card-123',
        projectId: null,
        workspaceMode: 'canonical',
        assignments: [
          {
            id: 'assign-1',
            workerId: 'researcher',
            task: 'Research',
            rationale: null,
            dependsOn: [],
            reviewRequired: false,
            state: 'queued',
            dispatchedAt: null,
            completedAt: null,
            reviewedAt: null,
            reviewedBy: null,
            checkpoint: null,
          },
        ],
        events: [],
      },
    ])
    writeKanbanCards([
      { id: 'card-123', title: 'Test', status: 'todo', missionId: 'mission-123' },
    ])

    vi.doMock('../../server/task-pipeline/dispatch-ready', () => ({
      dispatchReadyAssignments: vi.fn().mockResolvedValue({
        ok: true,
        dispatched: [
          { assignmentId: 'assign-1', workerId: 'researcher', ok: true },
        ],
      }),
    }))

    const handlers = await makeTaskIdHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/tasks/card-123/start', {
        method: 'POST',
      }),
      params: { taskId: 'card-123' },
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.dispatched).toHaveLength(1)
  })

  it('returns 400 when no assignments are ready', async () => {
    writeSwarmMissions([
      {
        id: 'mission-456',
        title: 'Blocked mission',
        state: 'blocked',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pipelineId: 'default-build',
        taskId: 'card-456',
        projectId: null,
        workspaceMode: 'canonical',
        assignments: [
          {
            id: 'assign-1',
            workerId: 'researcher',
            task: 'Research',
            rationale: null,
            dependsOn: [],
            reviewRequired: false,
            state: 'dispatched',
            dispatchedAt: Date.now(),
            completedAt: null,
            reviewedAt: null,
            reviewedBy: null,
            checkpoint: null,
          },
        ],
        events: [],
      },
    ])
    writeKanbanCards([
      { id: 'card-456', title: 'Test', status: 'running', missionId: 'mission-456' },
    ])

    vi.doMock('../../server/task-pipeline/dispatch-ready', () => ({
      dispatchReadyAssignments: vi.fn(),
    }))

    const handlers = await makeTaskIdHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/tasks/card-456/start', {
        method: 'POST',
      }),
      params: { taskId: 'card-456' },
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('No ready assignments')
  })

  it('returns 404 when task card is missing', async () => {
    writeKanbanCards([])

    const handlers = await makeTaskIdHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/tasks/missing/start', {
        method: 'POST',
      }),
      params: { taskId: 'missing' },
    })
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toContain('Task not found')
  })

  it('returns 400 when task has no bound mission', async () => {
    writeKanbanCards([
      { id: 'card-789', title: 'Orphan', status: 'todo', missionId: null },
    ])

    const handlers = await makeTaskIdHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/tasks/card-789/start', {
        method: 'POST',
      }),
      params: { taskId: 'card-789' },
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('No mission bound')
  })
})
