import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: Array<string> = []
const originalEnv = { ...process.env }

function makeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-multiplex-'))
  tempDirs.push(root)
  const hermesHome = path.join(root, '.hermes')
  mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })
  process.env.HERMES_HOME = hermesHome
  return hermesHome
}

beforeEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hermes-multiplex', () => {
  it('reads multiplex_profiles from config.yaml', async () => {
    const home = makeHome()
    writeFileSync(
      path.join(home, 'config.yaml'),
      'gateway:\n  multiplex_profiles: true\n',
    )
    const mod = await import('./hermes-multiplex')
    expect(mod.readMultiplexProfilesConfig()).toBe(true)
  })

  it('uses /p/<profile> URLs for named profiles', async () => {
    makeHome()
    const mod = await import('./hermes-multiplex')
    expect(mod.multiplexProfileGatewayUrl('default')).toBe(
      'http://127.0.0.1:8642',
    )
    expect(mod.multiplexProfileGatewayUrl('architect')).toBe(
      'http://127.0.0.1:8642/p/architect',
    )
  })

  it('treats a live served_profiles host as multiplex path for named agents', async () => {
    const home = makeHome()
    writeFileSync(
      path.join(home, 'gateway_state.json'),
      JSON.stringify({
        pid: process.pid,
        served_profiles: ['default', 'architect'],
      }),
    )
    vi.doMock('./gateway-port-owner', async () => {
      const actual = await vi.importActual<
        typeof import('./gateway-port-owner')
      >('./gateway-port-owner')
      return {
        ...actual,
        pidListeningOnPort: (port: number) =>
          port === 8642 ? process.pid : null,
        isPortInUse: (port: number) => port === 8642,
      }
    })
    const mod = await import('./hermes-multiplex')
    expect(mod.readLiveMultiplexGateway()?.servedProfiles).toContain(
      'architect',
    )
    expect(mod.isProfileMultiplexServed('architect')).toBe(true)
    expect(mod.shouldUseMultiplexGatewayPath('architect')).toBe(true)
    expect(mod.shouldUseMultiplexGatewayPath('default')).toBe(false)
  })

  it('getProfileGatewayUrl prefers multiplex when host is live', async () => {
    const home = makeHome()
    mkdirSync(path.join(home, 'profiles', 'architect'), { recursive: true })
    mkdirSync(path.join(home, 'workspace'), { recursive: true })
    process.env.AGORAX_STATE_DIR = path.join(home, 'workspace')
    writeFileSync(
      path.join(home, 'gateway_state.json'),
      JSON.stringify({
        pid: process.pid,
        served_profiles: ['default', 'architect'],
      }),
    )
    vi.doMock('./gateway-port-owner', async () => {
      const actual = await vi.importActual<
        typeof import('./gateway-port-owner')
      >('./gateway-port-owner')
      return {
        ...actual,
        pidListeningOnPort: (port: number) =>
          port === 8642 ? process.pid : null,
        isPortInUse: (port: number) => port === 8642,
      }
    })
    const ports = await import('./gateway-ports')
    expect(ports.getProfileGatewayUrl('architect')).toBe(
      'http://127.0.0.1:8642/p/architect',
    )
    expect(ports.getProfileGatewayUrl('default')).toBe('http://127.0.0.1:8642')
  })

  it('keeps multiplex routing for a standalone profile (mixed mode unsupported)', async () => {
    const home = makeHome()
    const aider = path.join(home, 'profiles', 'aider')
    mkdirSync(aider, { recursive: true })
    writeFileSync(
      path.join(aider, 'config.yaml'),
      'gateway:\n  standalone: true\n',
    )
    writeFileSync(path.join(aider, '.env'), 'API_SERVER_PORT=8650\n')
    mkdirSync(path.join(home, 'workspace'), { recursive: true })
    process.env.AGORAX_STATE_DIR = path.join(home, 'workspace')
    writeFileSync(
      path.join(home, 'gateway_state.json'),
      JSON.stringify({ pid: process.pid, served_profiles: ['default'] }),
    )
    vi.doMock('./gateway-port-owner', async () => {
      const actual = await vi.importActual<
        typeof import('./gateway-port-owner')
      >('./gateway-port-owner')
      return {
        ...actual,
        pidListeningOnPort: (port: number) =>
          port === 8642 ? process.pid : null,
        isPortInUse: (port: number) => port === 8642,
      }
    })
    const mod = await import('./hermes-multiplex')
    expect(mod.isProfileStandalone('aider')).toBe(true)
    expect(mod.isProfileStandalone('architect')).toBe(false)
    expect(mod.shouldUseMultiplexGatewayPath('aider')).toBe(true)
    const ports = await import('./gateway-ports')
    expect(ports.getProfileGatewayUrl('aider')).toBe(
      'http://127.0.0.1:8642/p/aider',
    )
  })
})
