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

vi.mock('../../server/rate-limit', () => ({
  requireJsonContentType: () => null,
}))

let tmpHome = ''
const originalEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in originalEnv)) originalEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function writeRuntime(workerId: string, runtime: Record<string, unknown>) {
  const profilePath = path.join(tmpHome, 'profiles', workerId)
  fs.mkdirSync(profilePath, { recursive: true })
  fs.writeFileSync(
    path.join(profilePath, 'runtime.json'),
    JSON.stringify(runtime, null, 2) + '\n',
    'utf-8',
  )
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-runtime-reset-'))
  setEnv('HERMES_HOME', tmpHome)
  vi.resetModules()
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(originalEnv)) delete originalEnv[key]
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

async function loadHandlers() {
  const mod = await import('./swarm-runtime.reset')
  return (mod as any).Route.server.handlers
}

describe('/api/swarm-runtime/reset', () => {
  it('resets the selected semantic worker runtimes', async () => {
    writeRuntime('orchestrator', {
      workerId: 'orchestrator',
      state: 'blocked',
      phase: 'stalled',
      currentTask: 'Need operator input',
      currentMissionId: 'mission-1',
      extraField: 'keep-me',
    })
    writeRuntime('researcher', {
      workerId: 'researcher',
      state: 'executing',
      phase: 'running',
      currentTask: 'still working',
    })

    const handlers = await loadHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/swarm-runtime/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workerIds: ['orchestrator'],
          actor: 'test-suite',
          reason: 'manual cleanup',
        }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.workerIds).toEqual(['orchestrator'])
    expect(body.resetCount).toBe(1)

    const orchestratorRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tmpHome, 'profiles', 'orchestrator', 'runtime.json'),
        'utf-8',
      ),
    )
    const researcherRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tmpHome, 'profiles', 'researcher', 'runtime.json'),
        'utf-8',
      ),
    )

    expect(orchestratorRuntime.state).toBe('idle')
    expect(orchestratorRuntime.phase).toBe('cancelled')
    expect(orchestratorRuntime.currentTask).toBeNull()
    expect(orchestratorRuntime.currentMissionId).toBeNull()
    expect(orchestratorRuntime.extraField).toBe('keep-me')
    expect(orchestratorRuntime.cancelledBy).toBe('test-suite')
    expect(researcherRuntime.state).toBe('executing')
  })

  it('resets all worker profiles but skips the synthetic workspace profile', async () => {
    writeRuntime('developer', {
      workerId: 'developer',
      state: 'blocked',
      phase: 'stalled',
    })
    writeRuntime('architect', {
      workerId: 'architect',
      state: 'executing',
      phase: 'running',
    })
    writeRuntime('workspace', {
      workerId: 'workspace',
      state: 'blocked',
      phase: 'stalled',
    })

    const handlers = await loadHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/swarm-runtime/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.workerIds).toEqual(
      expect.arrayContaining(['developer', 'architect']),
    )
    expect(body.workerIds).not.toContain('workspace')

    const developerRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tmpHome, 'profiles', 'developer', 'runtime.json'),
        'utf-8',
      ),
    )
    const architectRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tmpHome, 'profiles', 'architect', 'runtime.json'),
        'utf-8',
      ),
    )
    const workspaceRuntime = JSON.parse(
      fs.readFileSync(
        path.join(tmpHome, 'profiles', 'workspace', 'runtime.json'),
        'utf-8',
      ),
    )

    expect(developerRuntime.state).toBe('idle')
    expect(architectRuntime.state).toBe('idle')
    expect(workspaceRuntime.state).toBe('blocked')
  })

  it('rejects unknown worker ids', async () => {
    writeRuntime('developer', {
      workerId: 'developer',
      state: 'blocked',
      phase: 'stalled',
    })

    const handlers = await loadHandlers()
    const res = await handlers.POST({
      request: new Request('http://localhost/api/swarm-runtime/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerIds: ['ghost-worker'] }),
      }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('unknown worker ids')
  })
})
