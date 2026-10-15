import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => true,
}))

vi.mock('../../server/gateway-capabilities', () => ({
  ensureGatewayProbed: vi.fn(async () => ({ config: true })),
  getCapabilities: () => ({ config: true }),
}))

vi.mock('../../server/local-provider-discovery', () => ({
  ensureDiscovery: vi.fn(async () => {}),
  getDiscoveryStatus: () => [],
  getDiscoveredModels: () => [],
}))

let tmpHome = ''
const originalEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in originalEnv)) originalEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-config-route-'))
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

/** Load handlers from the shared route module (not createFileRoute wrappers). */
async function loadHandlers() {
  const mod = await import('../../server/hermes-config-route')
  return {
    GET: mod.handleHermesConfigGet,
    PATCH: mod.handleHermesConfigPatch,
  }
}

describe('canonical /api/hermes-config route', () => {
  it('GET returns normalized provider state with paths and active provider', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'provider: openrouter\nmodel: auto\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(tmpHome, '.env'),
      'OPENROUTER_API_KEY=sk-test-1234\n',
      'utf-8',
    )

    const handlers = await loadHandlers()
    const res = await handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.activeProvider).toBe('openrouter')
    expect(body.activeModel).toBe('auto')
    expect(body.paths.hermesHome).toBe(tmpHome)
    const openrouter = body.providers.find((p: any) => p.id === 'openrouter')
    expect(openrouter.configured).toBe(true)
    expect(openrouter.isDefault).toBe(true)
  })

  it('PATCH dispatches set-default-model and returns the action message', async () => {
    const handlers = await loadHandlers()
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'set-default-model',
          providerId: 'openrouter',
          modelId: 'auto',
        }),
      }),
    })
    const body = await res.json()

    expect(body).toMatchObject({ ok: true, message: 'Default model updated.' })
    expect(fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8')).toMatch(
      /provider: openrouter/,
    )
  })

  it('PATCH legacy { config } body deep-merges and preserves siblings', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'memory:\n  user_profile_enabled: true\n',
      'utf-8',
    )

    const handlers = await loadHandlers()
    await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({ config: { memory: { memory_enabled: true } } }),
      }),
    })

    const onDisk = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8')
    expect(onDisk).toContain('memory_enabled: true')
    expect(onDisk).toContain('user_profile_enabled: true')
  })

  it('PATCH rejects malformed action bodies with 400', async () => {
    const handlers = await loadHandlers()
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set-default-model' }),
      }),
    })
    expect(res.status).toBe(400)
  })

  it('GET returns local config without waiting for gateway probe', async () => {
    let resolveProbe: (() => void) | undefined
    const probeGate = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    vi.doMock('../../server/gateway-capabilities', () => ({
      ensureGatewayProbed: vi.fn(() => probeGate),
      getCapabilities: () => ({ config: false }),
    }))
    vi.doMock('../../server/local-provider-discovery', () => ({
      ensureDiscovery: vi.fn(() => new Promise(() => {})),
      getDiscoveryStatus: () => [],
      getDiscoveredModels: () => [],
    }))

    fs.writeFileSync(
      path.join(tmpHome, 'config.yaml'),
      'provider: openrouter\nmodel: auto\n',
      'utf-8',
    )

    const handlers = await loadHandlers()
    const getPromise = handlers.GET({
      request: new Request('http://localhost/api/hermes-config'),
    })

    const res = await Promise.race([
      getPromise,
      new Promise<Response>((_, reject) =>
        setTimeout(
          () => reject(new Error('GET blocked on gateway probe')),
          200,
        ),
      ),
    ])
    const body = await res.json()

    expect(body.activeProvider).toBe('openrouter')
    expect(body.activeModel).toBe('auto')
    resolveProbe?.()
    vi.doUnmock('../../server/gateway-capabilities')
    vi.doUnmock('../../server/local-provider-discovery')
  })

  it('PATCH returns 503 when the gateway capability is unavailable', async () => {
    vi.doMock('../../server/gateway-capabilities', () => ({
      ensureGatewayProbed: vi.fn(async () => ({ config: false })),
      getCapabilities: () => ({ config: false }),
    }))
    const handlers = await loadHandlers()
    const res = await handlers.PATCH({
      request: new Request('http://localhost/api/hermes-config', {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'set-api-key',
          envKey: 'X',
          value: 'y',
        }),
      }),
    })
    expect(res.status).toBe(503)
    vi.doUnmock('../../server/gateway-capabilities')
  })
})
