import { describe, expect, it } from 'vitest'
import {
  remoteUrlMatches,
  updateAvailableFromDivergence,
} from './update-system'

describe('update-system helpers', () => {
  it('matches GitHub URL forms against expected repo aliases', () => {
    expect(
      remoteUrlMatches('https://github.com/outsourc-e/hermes-workspace.git', [
        'outsourc-e/hermes-workspace',
      ]),
    ).toBe(true)
    expect(
      remoteUrlMatches('git@github.com:NousResearch/hermes-agent.git', [
        'hermes-agent',
      ]),
    ).toBe(true)
    expect(
      remoteUrlMatches('https://github.com/example/other.git', [
        'hermes-workspace',
      ]),
    ).toBe(false)
  })

  it('only reports update availability when the remote side is ahead', () => {
    expect(updateAvailableFromDivergence({ ahead: 2, behind: 0 }, true)).toBe(
      false,
    )
    expect(updateAvailableFromDivergence({ ahead: 0, behind: 3 }, true)).toBe(
      true,
    )
    expect(updateAvailableFromDivergence({ ahead: 2, behind: 3 }, true)).toBe(
      true,
    )
    expect(updateAvailableFromDivergence({ ahead: 0, behind: 0 }, false)).toBe(
      false,
    )
    // Unknown divergence must not advertise an update (avoids false positives).
    expect(updateAvailableFromDivergence(null, true)).toBe(false)
  })

  it('exports a 24h update-check TTL aligned with the Runtimes daily poll', async () => {
    const { UPDATE_CHECK_TTL_MS } = await import('./update-system')
    const { PRODUCT_UPDATE_CHECK_INTERVAL_MS } = await import(
      '@/lib/managed-agent-runtime/update-check-ttl'
    )
    expect(UPDATE_CHECK_TTL_MS).toBe(PRODUCT_UPDATE_CHECK_INTERVAL_MS)
    expect(UPDATE_CHECK_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
