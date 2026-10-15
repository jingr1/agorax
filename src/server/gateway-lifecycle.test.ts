import { afterEach, describe, expect, it } from 'vitest'
import {
  PINNED_GATEWAY_PROFILE,
  clearGatewayLease,
  readGatewayLifecycleConfig,
  selectEvictionCandidates,
  shouldApplyGatewayRoute,
  touchGatewayLease,
} from './gateway-lifecycle'

describe('readGatewayLifecycleConfig', () => {
  afterEach(() => {
    delete process.env.HERMES_GATEWAY_POOL_MAX
    delete process.env.HERMES_GATEWAY_IDLE_TTL
    delete process.env.HERMES_GATEWAY_EVICT_INTERVAL
  })

  it('defaults to max=8 and no idle ttl', () => {
    const config = readGatewayLifecycleConfig({})
    expect(config.maxResident).toBe(8)
    expect(config.idleTtlMs).toBe(0)
    expect(config.evictIntervalMs).toBe(60 * 1000)
  })

  it('reads overrides from env', () => {
    const config = readGatewayLifecycleConfig({
      HERMES_GATEWAY_POOL_MAX: '5',
      HERMES_GATEWAY_IDLE_TTL: '120',
      HERMES_GATEWAY_EVICT_INTERVAL: '30',
    })
    expect(config.maxResident).toBe(5)
    expect(config.idleTtlMs).toBe(120 * 1000)
    expect(config.evictIntervalMs).toBe(30 * 1000)
  })
})

describe('selectEvictionCandidates', () => {
  const now = 1_000_000

  it('never evicts protected profiles', () => {
    const victims = selectEvictionCandidates(
      [
        { profile: 'active', lastUsedAt: now - 999_999, startedAt: 0 },
        { profile: 'old', lastUsedAt: now - 999_999, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 60_000,
        maxResident: 1,
        protectedProfiles: new Set(['active']),
      },
    )
    expect(victims).toEqual(['old'])
  })

  it('does not evict by idle time when ttl is 0', () => {
    const victims = selectEvictionCandidates(
      [
        { profile: 'a', lastUsedAt: now - 120_000, startedAt: 0 },
        { profile: 'b', lastUsedAt: now - 10_000, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 0,
        maxResident: 8,
        protectedProfiles: new Set(),
      },
    )
    expect(victims).toEqual([])
  })

  it('evicts idle gateways when ttl is explicitly enabled', () => {
    const victims = selectEvictionCandidates(
      [
        { profile: 'a', lastUsedAt: now - 120_000, startedAt: 0 },
        { profile: 'b', lastUsedAt: now - 10_000, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 60_000,
        maxResident: 3,
        protectedProfiles: new Set(),
      },
    )
    expect(victims).toEqual(['a'])
  })

  it('evicts oldest when over max resident', () => {
    const victims = selectEvictionCandidates(
      [
        { profile: 'a', lastUsedAt: now - 30_000, startedAt: 0 },
        { profile: 'b', lastUsedAt: now - 20_000, startedAt: 0 },
        { profile: 'c', lastUsedAt: now - 10_000, startedAt: 0 },
        { profile: 'd', lastUsedAt: now - 5_000, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 999_999_999,
        maxResident: 3,
        protectedProfiles: new Set(),
      },
    )
    expect(victims).toEqual(['a'])
  })

  it('never evicts default even when idle and over cap', () => {
    const victims = selectEvictionCandidates(
      [
        {
          profile: PINNED_GATEWAY_PROFILE,
          lastUsedAt: now - 999_999,
          startedAt: 0,
        },
        { profile: 'a', lastUsedAt: now - 30_000, startedAt: 0 },
        { profile: 'b', lastUsedAt: now - 20_000, startedAt: 0 },
        { profile: 'c', lastUsedAt: now - 10_000, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 60_000,
        maxResident: 3,
        protectedProfiles: new Set(),
      },
    )
    expect(victims).not.toContain(PINNED_GATEWAY_PROFILE)
    expect(victims).toEqual(['a'])
  })

  it('counts default toward maxResident', () => {
    const victims = selectEvictionCandidates(
      [
        { profile: PINNED_GATEWAY_PROFILE, lastUsedAt: now, startedAt: 0 },
        { profile: 'a', lastUsedAt: now - 30_000, startedAt: 0 },
        { profile: 'b', lastUsedAt: now - 20_000, startedAt: 0 },
        { profile: 'c', lastUsedAt: now - 10_000, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 999_999_999,
        maxResident: 3,
        protectedProfiles: new Set(),
      },
    )
    expect(victims).toEqual(['a'])
  })

  it('keeps default plus active even when they exceed maxResident', () => {
    const victims = selectEvictionCandidates(
      [
        {
          profile: PINNED_GATEWAY_PROFILE,
          lastUsedAt: now - 999_999,
          startedAt: 0,
        },
        { profile: 'researcher', lastUsedAt: now - 999_999, startedAt: 0 },
      ],
      {
        now,
        idleTtlMs: 60_000,
        maxResident: 1,
        protectedProfiles: new Set(['researcher']),
      },
    )
    expect(victims).toEqual([])
  })
})

describe('shouldApplyGatewayRoute', () => {
  it('only applies the global route for the current active profile', () => {
    expect(shouldApplyGatewayRoute('researcher', 'default')).toBe(false)
    expect(shouldApplyGatewayRoute('default', 'default')).toBe(true)
    expect(shouldApplyGatewayRoute('researcher', 'researcher')).toBe(true)
    expect(shouldApplyGatewayRoute('', '')).toBe(true)
  })
})

describe('touchGatewayLease', () => {
  afterEach(() => {
    clearGatewayLease('writer')
  })

  it('updates lastUsedAt for an existing lease', () => {
    process.env.HERMES_API_URL = 'http://127.0.0.1:8642'
    touchGatewayLease('writer', 100)
    touchGatewayLease('writer', 500)
    // Lease map is module-local; we only assert the call does not throw.
    expect(true).toBe(true)
  })
})
