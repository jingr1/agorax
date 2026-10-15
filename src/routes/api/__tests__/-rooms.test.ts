/** @vitest-environment node */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: any) => opts,
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

let tmpHome = ''

/** Seed missions into collab.db (JSON file store is legacy). */
async function seedMissions(
  missions: Array<{ id: string; title: string }>,
): Promise<void> {
  const { createOrUpdateMission } = await import(
    '../../../server/swarm-missions'
  )
  for (const mission of missions) {
    createOrUpdateMission({
      missionId: mission.id,
      title: mission.title,
      assignments: [],
    })
  }
}

async function makePostHandlers() {
  const mod = await import('../rooms')
  return (mod as any).Route.server.handlers
}

async function makeRoomIdHandlers() {
  const mod = await import('../rooms/$roomId')
  return (mod as any).Route.server.handlers
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-route-test-'))
  const collabDb = path.join(tmpHome, 'collab.db')
  vi.stubEnv('HERMES_HOME', tmpHome)
  // Keep collab.db off the live ~/.hermes path (readonly under the
  // running gateway / sandbox).
  vi.stubEnv('HERMES_COLLAB_DB', collabDb)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('POST /api/rooms taskId -> missionId backfill', () => {
  it('writes taskId into missionId when taskId is an existing mission id', async () => {
    await seedMissions([{ id: 'mission-123', title: 'Existing mission' }])

    const handlers = await makePostHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room for mission',
          taskId: 'mission-123',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.room.taskId).toBe('mission-123')
    expect(body.room.missionId).toBe('mission-123')
  })

  it('does NOT overwrite missionId when taskId is not a known mission id', async () => {
    const handlers = await makePostHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room with kanban task',
          taskId: 'kanban-task-456',
          missionId: 'explicit-mission-789',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.room.taskId).toBe('kanban-task-456')
    expect(body.room.missionId).toBe('explicit-mission-789')
  })

  it('falls back to null missionId when no taskId or missionId is supplied', async () => {
    const handlers = await makePostHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Standalone room' }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.room.taskId).toBeNull()
    expect(body.room.missionId).toBeNull()
  })
})

describe('PATCH /api/rooms/$roomId taskId -> missionId backfill', () => {
  it('backfills missionId when taskId is updated to an existing mission id', async () => {
    await seedMissions([{ id: 'mission-abc', title: 'Another mission' }])

    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Room to patch' }),
      }),
    })
    const { room } = await createRes.json()

    const patchHandlers = await makeRoomIdHandlers()
    const patchRes = await patchHandlers.PATCH({
      request: new Request(`http://localhost/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'mission-abc' }),
      }),
      params: { roomId: room.id },
    })
    const patched = await patchRes.json()

    expect(patchRes.status).toBe(200)
    expect(patched.ok).toBe(true)
    expect(patched.room.taskId).toBe('mission-abc')
    expect(patched.room.missionId).toBe('mission-abc')
  })

  it('leaves missionId alone when taskId is not a known mission id', async () => {
    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room to patch',
          missionId: 'mission-xyz',
        }),
      }),
    })
    const { room } = await createRes.json()

    const patchHandlers = await makeRoomIdHandlers()
    const patchRes = await patchHandlers.PATCH({
      request: new Request(`http://localhost/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'kanban-task-999' }),
      }),
      params: { roomId: room.id },
    })
    const patched = await patchRes.json()

    expect(patchRes.status).toBe(200)
    expect(patched.ok).toBe(true)
    expect(patched.room.taskId).toBe('kanban-task-999')
    expect(patched.room.missionId).toBe('mission-xyz')
  })

  it('clears missionId when taskId is set to null', async () => {
    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Room to clear',
          taskId: 'kanban-task-111',
          missionId: 'mission-xyz',
        }),
      }),
    })
    const { room } = await createRes.json()

    const patchHandlers = await makeRoomIdHandlers()
    const patchRes = await patchHandlers.PATCH({
      request: new Request(`http://localhost/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: null }),
      }),
      params: { roomId: room.id },
    })
    const patched = await patchRes.json()

    expect(patchRes.status).toBe(200)
    expect(patched.ok).toBe(true)
    expect(patched.room.taskId).toBeNull()
    expect(patched.room.missionId).toBeNull()
  })
})

describe('POST/PATCH workspacePath', () => {
  it('creates an ad-hoc room with workspacePath', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-ws-'))
    try {
      const handlers = await makePostHandlers()
      const res = await handlers.POST({
        request: new Request('http://localhost/api/rooms', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'With workspace',
            workspacePath: ws,
          }),
        }),
      })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.room.workspacePath).toBe(path.resolve(ws))
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })

  it('rejects workspacePath changes on mission-bound rooms', async () => {
    await seedMissions([{ id: 'mission-lock', title: 'Locked' }])
    const postHandlers = await makePostHandlers()
    const createRes = await postHandlers.POST({
      request: new Request('http://localhost/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Mission room',
          missionId: 'mission-lock',
        }),
      }),
    })
    const { room } = await createRes.json()
    expect(room.missionId).toBe('mission-lock')

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-ws-lock-'))
    try {
      const patchHandlers = await makeRoomIdHandlers()
      const patchRes = await patchHandlers.PATCH({
        request: new Request(`http://localhost/api/rooms/${room.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspacePath: ws }),
        }),
        params: { roomId: room.id },
      })
      const body = await patchRes.json()
      expect(patchRes.status).toBe(409)
      expect(body.ok).toBe(false)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })
})
