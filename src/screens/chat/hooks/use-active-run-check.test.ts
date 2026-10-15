import { describe, expect, it } from 'vitest'
import { decideActiveRunRemountAction } from './use-active-run-check'

describe('decideActiveRunRemountAction', () => {
  it('leaves waiting alone when the server still has a live run', () => {
    expect(
      decideActiveRunRemountAction({
        runId: 'run-1',
        status: 'active',
        sessionKey: 'sess',
        startedAt: Date.now(),
      }),
    ).toBe('leave')
  })

  it('clears orphan waiting/streaming when there is no live run', () => {
    expect(decideActiveRunRemountAction(null)).toBe('clear-orphan')
    expect(
      decideActiveRunRemountAction({
        runId: 'run-1',
        status: 'complete',
        sessionKey: 'sess',
        startedAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      }),
    ).toBe('clear-orphan')
  })
})
