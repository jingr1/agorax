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

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

const dispatchReadyAssignments = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    dispatched: [
      { assignmentId: 'assign-1', workerId: 'researcher', ok: true },
    ],
  }),
)

vi.mock('../../../server/task-pipeline/dispatch-ready', () => ({
  dispatchReadyAssignments,
}))

let tmpHome = ''
let missionsPath = ''
let kanbanPath = ''

function writeSwarmMissions(missions: Array<Record<string, unknown>>) {
  fs.mkdirSync(path.dirname(missionsPath), { recursive: true })
  fs.writeFileSync(
    missionsPath,
    JSON.stringify({ version: 1, missions }, null, 2) + '\n',
    'utf-8',
  )
}

function writeKanbanCards(cards: Array<Record<string, unknown>>) {
  fs.mkdirSync(path.dirname(kanbanPath), { recursive: true })
  fs.writeFileSync(
    kanbanPath,
    JSON.stringify({ cards }, null, 2) + '\n',
    'utf-8',
  )
}

async function makeTaskIdHandlers() {
  const mod = await import('./$taskId')
  return (mod as any).Route.server.handlers
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-start-route-test-'))
  missionsPath = path.join(tmpHome, '.runtime', 'swarm-missions.json')
  kanbanPath = path.join(tmpHome, 'swarm2-kanban.json')
  // Avoid process.chdir — cwd is process-global and races under vitest threads.
  vi.stubEnv('HERMES_HOME', tmpHome)
  vi.stubEnv('CLAUDE_KANBAN_BACKEND', 'local')
  vi.stubEnv('HERMES_COLLAB_DB', path.join(tmpHome, 'collab.db'))
  dispatchReadyAssignments.mockReset()
  dispatchReadyAssignments.mockResolvedValue({
    ok: true,
    dispatched: [
      { assignmentId: 'assign-1', workerId: 'researcher', ok: true },
    ],
  })
  vi.resetModules()
  vi.doMock('../../../server/swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tmpHome,
    SWARM_MISSIONS_PATH: missionsPath,
    SWARM_MEMORY_ROOT: path.join(tmpHome, 'memory'),
    SWARM_MEMORY_HANDOFFS: path.join(tmpHome, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: path.join(tmpHome, 'output'),
    SWARM_FORBIDDEN_PATHS: [],
    getSwarmEnvironment: () => ({
      canonicalRepo: tmpHome,
      hermesRoot: tmpHome,
    }),
    isForbiddenSwarmPath: () => false,
  }))
})

afterEach(() => {
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
    expect(dispatchReadyAssignments).toHaveBeenCalledWith('mission-123')
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
      {
        id: 'card-456',
        title: 'Blocked',
        status: 'in_progress',
        missionId: 'mission-456',
      },
    ])

    const handlers = await makeTaskIdHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/tasks/card-456/start', {
        method: 'POST',
      }),
      params: { taskId: 'card-456' },
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/No ready assignments/i)
    expect(dispatchReadyAssignments).not.toHaveBeenCalled()
  })

  it('returns 404 when the task card is missing', async () => {
    writeSwarmMissions([])
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
    expect(body.error).toMatch(/not found/i)
  })

  it('returns 400 when the card has no bound mission', async () => {
    writeSwarmMissions([])
    writeKanbanCards([{ id: 'card-orphan', title: 'Orphan', status: 'todo' }])

    const handlers = await makeTaskIdHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/tasks/card-orphan/start', {
        method: 'POST',
      }),
      params: { taskId: 'card-orphan' },
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/No mission bound/i)
  })
})
