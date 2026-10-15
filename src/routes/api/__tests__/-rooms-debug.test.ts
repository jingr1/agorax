import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path) => (opts) => opts,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))

let tmpHome
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-route-test-'))
  vi.stubEnv('HERMES_HOME', tmpHome)
  vi.stubEnv('HERMES_HOME', '')
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('debug', () => {
  it('logs module shape', async () => {
    const mod = await import('../rooms')
    console.log('mod keys', Object.keys(mod))
    console.log('mod.Route', mod.Route)
    console.log('typeof Route', typeof mod.Route)
    console.log('Route.server', (mod as any).Route?.server)
  })
})
