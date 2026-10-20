import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stopProfileGateway = vi.hoisted(() =>
  vi.fn(() => ({ ok: true, message: 'not running' })),
)
const topologyKind = vi.hoisted(() => ({
  current: 'multiplex' as 'multiplex' | 'per-port' | 'remote',
}))

vi.mock('./hermes-agent', () => ({
  stopProfileGateway,
  isHermesAgentHealthy: vi.fn(async () => false),
}))

vi.mock('./profiles-browser', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('./gateway-pool', () => ({
  probeProfileGateway: vi.fn(async () => true),
  ensureProfileGateway: vi.fn(async () => ({
    ok: true,
    message: 'already running',
  })),
}))

vi.mock('./gateway-ports', () => ({
  PINNED_GATEWAY_PROFILE: 'default',
  isGatewayPoolEnabled: () => true,
  listManagedProfileNames: () => ['default', 'architect', 'dev-1'],
  listPersistedOrphanProfilePorts: () => [],
  resolveProfileGatewayPort: () => 8643,
  resolveGatewayTopology: () => {
    if (topologyKind.current === 'multiplex') {
      return {
        kind: 'multiplex' as const,
        port: 8642,
        served: ['default', 'architect', 'dev-1'],
      }
    }
    if (topologyKind.current === 'remote') {
      return { kind: 'remote' as const, url: 'http://100.64.0.10:8642' }
    }
    return { kind: 'per-port' as const }
  },
}))

import { clearGatewayLease, runEvictionCycle } from './gateway-lifecycle'

describe('runEvictionCycle topology', () => {
  beforeEach(() => {
    stopProfileGateway.mockReset()
    stopProfileGateway.mockReturnValue({ ok: true, message: 'not running' })
    topologyKind.current = 'multiplex'
    delete process.env.HERMES_GATEWAY_POOL_MAX
    for (const name of ['default', 'architect', 'dev-1']) {
      clearGatewayLease(name)
    }
  })

  afterEach(() => {
    delete process.env.HERMES_GATEWAY_POOL_MAX
    vi.restoreAllMocks()
  })

  it('does not stop named profiles while the multiplex host is the only process', async () => {
    const victims = await runEvictionCycle()
    expect(victims).toEqual([])
    expect(stopProfileGateway).not.toHaveBeenCalled()
  })

  it('does not evict when pairing is remote', async () => {
    topologyKind.current = 'remote'
    const victims = await runEvictionCycle()
    expect(victims).toEqual([])
    expect(stopProfileGateway).not.toHaveBeenCalled()
  })

  it('evicts oldest per-port processes and logs only a real stop', async () => {
    topologyKind.current = 'per-port'
    process.env.HERMES_GATEWAY_POOL_MAX = '1'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const skipped = await runEvictionCycle()
    expect(skipped.sort()).toEqual(['architect', 'dev-1'])
    expect(stopProfileGateway).toHaveBeenCalledTimes(2)
    expect(log).not.toHaveBeenCalled()

    stopProfileGateway.mockReturnValue({ ok: true, message: 'stopped' })
    clearGatewayLease('architect')
    clearGatewayLease('dev-1')
    const stopped = await runEvictionCycle()
    expect(stopped.sort()).toEqual(['architect', 'dev-1'])
    expect(log).toHaveBeenCalledWith(
      '[gateway-pool] evicted gateway for profile architect',
    )
    expect(log).toHaveBeenCalledWith(
      '[gateway-pool] evicted gateway for profile dev-1',
    )
  })
})
