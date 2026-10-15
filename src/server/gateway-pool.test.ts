import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const tempDirs: Array<string> = []
const originalEnv = { ...process.env }

function makeHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hermes-gateway-pool-'))
  tempDirs.push(root)
  const hermesHome = path.join(root, '.hermes')
  mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })
  mkdirSync(path.join(hermesHome, 'workspace'), { recursive: true })
  process.env.HERMES_HOME = hermesHome
  process.env.AGORAX_STATE_DIR = path.join(hermesHome, 'workspace')
  delete process.env.HERMES_API_URL
  delete process.env.HERMES_GATEWAY_POOL
  return hermesHome
}

function addProfile(hermesHome: string, name: string): string {
  const dir = path.join(hermesHome, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function loadMod() {
  return import('./gateway-ports')
}

beforeEach(async () => {
  process.env = { ...originalEnv }
  const mod = await loadMod()
  mod.clearPortAssignmentCache()
})

afterEach(async () => {
  process.env = { ...originalEnv }
  try {
    const mod = await loadMod()
    mod.clearPortAssignmentCache()
  } catch {
    // module may not have loaded
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('gateway-pool port assignment', () => {
  it('assigns default=8642 then remaining profiles alphabetically', async () => {
    const home = makeHome()
    addProfile(home, 'writer')
    addProfile(home, 'architect')
    addProfile(home, 'developer')

    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('default')).toBe(8642)
    expect(mod.resolveProfileGatewayPort('architect')).toBe(8643)
    expect(mod.resolveProfileGatewayPort('developer')).toBe(8644)
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8645)
  })

  it('does not reshuffle existing ports when a new profile appears', async () => {
    const home = makeHome()
    addProfile(home, 'architect')
    addProfile(home, 'writer')
    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8644)

    addProfile(home, 'developer')
    expect(mod.resolveProfileGatewayPort('architect')).toBe(8643)
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8644)
    expect(mod.resolveProfileGatewayPort('developer')).toBe(8645)
  })

  it('keeps default on 8642 even if persist mapped another profile there', async () => {
    const home = makeHome()
    addProfile(home, 'writer')
    writeFileSync(
      path.join(home, 'workspace', 'gateway-pool.json'),
      JSON.stringify({ ports: { writer: 8642, default: 8645 } }),
    )

    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('default')).toBe(8642)
    expect(mod.resolveProfileGatewayPort('writer')).not.toBe(8642)
  })

  it('honors a unique profile .env port', async () => {
    const home = makeHome()
    const writer = addProfile(home, 'writer')
    writeFileSync(path.join(writer, '.env'), 'API_SERVER_PORT=8701\n')

    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8701)
    expect(mod.resolveProfileGatewayPort('default')).toBe(8642)
  })

  it('ignores API_SERVER_PORT from a .env symlink to the hermes root', async () => {
    const home = makeHome()
    writeFileSync(
      path.join(home, '.env'),
      'API_SERVER_PORT=8642\nAPI_SERVER_ENABLED=true\n',
    )
    const writer = addProfile(home, 'writer')
    symlinkSync(path.join(home, '.env'), path.join(writer, '.env'))

    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8643)
  })

  it('honors config.yaml gateway.api_server.port', async () => {
    const home = makeHome()
    const architect = addProfile(home, 'architect')
    writeFileSync(
      path.join(architect, 'config.yaml'),
      'gateway:\n  api_server:\n    enabled: true\n    port: 8699\n',
    )

    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('architect')).toBe(8699)
  })

  it('drops persisted ports when the profile directory no longer exists', async () => {
    const home = makeHome()
    addProfile(home, 'developer')
    writeFileSync(
      path.join(home, 'workspace', 'gateway-pool.json'),
      JSON.stringify({
        ports: {
          default: 8642,
          developer: 8652,
          coder: 8644,
          strategist: 8650,
        },
      }),
    )

    const mod = await loadMod()
    expect(mod.listManagedProfileNames()).toEqual(['default', 'developer'])
    expect(mod.resolveProfileGatewayPort('developer')).toBe(8652)

    const persisted = JSON.parse(
      readFileSync(path.join(home, 'workspace', 'gateway-pool.json'), 'utf-8'),
    ) as { ports: Record<string, number> }
    expect(persisted.ports.coder).toBeUndefined()
    expect(persisted.ports.strategist).toBeUndefined()
    expect(persisted.ports.developer).toBe(8652)
  })

  it('lists persisted ports for profiles that no longer exist on disk', async () => {
    const home = makeHome()
    addProfile(home, 'developer')
    writeFileSync(
      path.join(home, 'workspace', 'gateway-pool.json'),
      JSON.stringify({
        ports: { default: 8642, developer: 8652, designer: 8644 },
      }),
    )

    const mod = await loadMod()
    expect(mod.listPersistedOrphanProfilePorts()).toEqual([
      { profile: 'designer', port: 8644 },
    ])
  })
})

describe('isGatewayPoolEnabled', () => {
  it('defaults on for loopback pairing', async () => {
    makeHome()
    process.env.HERMES_API_URL = 'http://127.0.0.1:8642'
    const mod = await loadMod()
    expect(mod.isGatewayPoolEnabled()).toBe(true)
  })

  it('defaults off for remote pairing', async () => {
    makeHome()
    process.env.HERMES_API_URL = 'http://100.64.0.10:8642'
    const mod = await loadMod()
    expect(mod.isGatewayPoolEnabled()).toBe(false)
  })

  it('can be forced off', async () => {
    makeHome()
    process.env.HERMES_API_URL = 'http://127.0.0.1:8642'
    process.env.HERMES_GATEWAY_POOL = '0'
    const mod = await loadMod()
    expect(mod.isGatewayPoolEnabled()).toBe(false)
  })

  it('ignores the removed CLAUDE_GATEWAY_POOL_ENABLED name', async () => {
    makeHome()
    process.env.HERMES_API_URL = 'http://100.64.0.10:8642'
    process.env.CLAUDE_GATEWAY_POOL_ENABLED = '1'
    const mod = await loadMod()
    expect(mod.isGatewayPoolEnabled()).toBe(false)
  })
})

describe('profileNameFromHermesHome', () => {
  it('maps default and named profile homes', async () => {
    const home = makeHome()
    addProfile(home, 'writer')
    const mod = await loadMod()
    expect(mod.profileNameFromHermesHome(home)).toBe('default')
    expect(
      mod.profileNameFromHermesHome(path.join(home, 'profiles', 'writer')),
    ).toBe('writer')
  })
})

describe('ensureProfileApiServerEnv', () => {
  it('writes pool port and copies API_SERVER_KEY from default when missing', async () => {
    const home = makeHome()
    delete process.env.API_SERVER_KEY
    writeFileSync(
      path.join(home, '.env'),
      'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=default-profile-api-key-16\n',
    )
    const writer = addProfile(home, 'writer')
    writeFileSync(path.join(writer, '.env'), 'API_SERVER_ENABLED=true\n')

    const mod = await loadMod()
    const env = mod.ensureProfileApiServerEnv('writer', 8644)
    expect(env.API_SERVER_PORT).toBe('8644')
    expect(env.API_SERVER_KEY).toBe('default-profile-api-key-16')

    const raw = readFileSync(path.join(writer, '.env'), 'utf-8')
    expect(raw).toContain('API_SERVER_PORT=8644')
    expect(raw).toContain('API_SERVER_KEY=default-profile-api-key-16')
  })

  it('auto-heals a profile .env symlink to the hermes root', async () => {
    const home = makeHome()
    writeFileSync(
      path.join(home, '.env'),
      'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=default-profile-api-key-16\nAPI_SERVER_PORT=8642\n',
    )
    const writer = addProfile(home, 'writer')
    symlinkSync(path.join(home, '.env'), path.join(writer, '.env'))

    const mod = await loadMod()
    const env = mod.ensureProfileApiServerEnv('writer', 8644)
    expect(env.API_SERVER_PORT).toBe('8644')
    expect(lstatSync(path.join(writer, '.env')).isSymbolicLink()).toBe(false)
    const raw = readFileSync(path.join(writer, '.env'), 'utf-8')
    expect(raw).toContain('API_SERVER_PORT=8644')
    // Root file must stay untouched.
    expect(readFileSync(path.join(home, '.env'), 'utf-8')).toContain(
      'API_SERVER_PORT=8642',
    )
  })
})

describe('bindProfileToPort', () => {
  it('does not steal default 8642 for a live occupant', async () => {
    const home = makeHome()
    addProfile(home, 'writer')
    const mod = await loadMod()
    expect(mod.resolveProfileGatewayPort('default')).toBe(8642)
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8643)

    mod.bindProfileToPort('writer', 8642)

    expect(mod.resolveProfileGatewayPort('default')).toBe(8642)
    expect(mod.resolveProfileGatewayPort('writer')).toBe(8643)
  })
})
