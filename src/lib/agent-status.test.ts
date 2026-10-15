/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  UNSTABLE_MS,
  WORK_STALE_MS,
  deriveAgentPresence,
  deriveAvailability,
  deriveWorkload,
  foldPresenceToUnifiedStatus,
} from './agent-status'

describe('deriveAvailability', () => {
  const now = 1_000_000_000_000

  it('is online when probe succeeds', () => {
    expect(deriveAvailability({ probeAvailable: true }, now)).toBe('online')
  })

  it('is unstable when probe fails but last seen within window', () => {
    expect(
      deriveAvailability(
        {
          probeAvailable: false,
          runtimeLastOutputAt: now - UNSTABLE_MS + 1_000,
        },
        now,
      ),
    ).toBe('unstable')
  })

  it('is offline when probe fails and last seen is stale/missing', () => {
    expect(
      deriveAvailability(
        {
          probeAvailable: false,
          runtimeLastOutputAt: now - UNSTABLE_MS - 1,
        },
        now,
      ),
    ).toBe('offline')
    expect(deriveAvailability({ probeAvailable: false }, now)).toBe('offline')
  })
})

describe('deriveWorkload', () => {
  const now = 1_000_000_000_000

  it('is working only with busy state AND fresh output', () => {
    expect(
      deriveWorkload(
        {
          runtimeState: 'executing',
          runtimeLastOutputAt: now - 1_000,
        },
        now,
      ),
    ).toBe('working')

    expect(
      deriveWorkload(
        {
          runtimeState: 'executing',
          runtimeLastOutputAt: now - WORK_STALE_MS - 1,
        },
        now,
      ),
    ).toBe('idle')
  })

  it('is queued when needs human, independent of probe', () => {
    expect(
      deriveWorkload({ runtimeNeedsHuman: true, runtimeState: 'blocked' }, now),
    ).toBe('queued')
  })

  it('ignores sticky currentTask without live busy/queue signals', () => {
    expect(
      deriveWorkload(
        {
          currentTask: 'old-task',
          missionId: 'm-1',
          runtimeState: 'idle',
        },
        now,
      ),
    ).toBe('idle')
  })
})

describe('deriveAgentPresence (dual axis)', () => {
  const now = 1_000_000_000_000

  it('keeps availability ⊥ workload when probe is down but work is fresh', () => {
    const presence = deriveAgentPresence(
      {
        hasModel: true,
        probeAvailable: false,
        runtimeState: 'executing',
        runtimeLastOutputAt: now - 30_000,
      },
      now,
    )
    expect(presence.availability).toBe('unstable')
    expect(presence.workload).toBe('working')
    // Fold: unstable + working → active (reachable-ish).
    expect(presence.unifiedStatus).toBe('active')
  })

  it('returns needsSetup when hasModel is false', () => {
    expect(
      deriveAgentPresence({ hasModel: false, probeAvailable: true }, now)
        .unifiedStatus,
    ).toBe('needsSetup')
  })

  it('folds offline over sticky needsHuman when probe fails and last seen cold', () => {
    expect(
      deriveAgentPresence(
        {
          hasModel: true,
          probeAvailable: false,
          runtimeNeedsHuman: true,
        },
        now,
      ).unifiedStatus,
    ).toBe('offline')
  })

  it('does not use group-chat online for availability', () => {
    const presence = deriveAgentPresence(
      {
        hasModel: true,
        probeAvailable: false,
        groupChatOnline: true,
        groupChatLastMessageAt: now,
      },
      now,
    )
    expect(presence.availability).toBe('offline')
    expect(presence.unifiedStatus).toBe('offline')
  })

  it('is idle when probe ok and no live work', () => {
    expect(
      deriveAgentPresence(
        {
          hasModel: true,
          probeAvailable: true,
          runtimeState: 'executing',
          runtimeLastOutputAt: now - WORK_STALE_MS - 1,
        },
        now,
      ).unifiedStatus,
    ).toBe('idle')
  })

  it('is active when working and probe ok', () => {
    expect(
      deriveAgentPresence(
        {
          hasModel: true,
          probeAvailable: true,
          runtimeState: 'executing',
          runtimeLastOutputAt: now - 1_000,
        },
        now,
      ).unifiedStatus,
    ).toBe('active')
  })

  it('is blocked when needsHuman and probe ok', () => {
    const presence = deriveAgentPresence(
      {
        hasModel: true,
        probeAvailable: true,
        runtimeNeedsHuman: true,
      },
      now,
    )
    expect(presence.blocked).toBe(true)
    expect(presence.workload).toBe('queued')
    expect(presence.unifiedStatus).toBe('blocked')
  })
})

describe('foldPresenceToUnifiedStatus', () => {
  it('prefers needsSetup over everything', () => {
    expect(
      foldPresenceToUnifiedStatus({
        availability: 'online',
        workload: 'working',
        needsSetup: true,
        blocked: true,
        error: true,
      }),
    ).toBe('needsSetup')
  })
})
