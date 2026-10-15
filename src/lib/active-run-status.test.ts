import { describe, expect, it } from 'vitest'

import { isActiveRunStatus } from './active-run-status'

describe('active-run-status', () => {
  it('treats fresh handoff runs as active but stale ones as inactive', () => {
    const now = Date.now()
    expect(isActiveRunStatus('handoff', now, now)).toBe(true)
    expect(isActiveRunStatus('handoff', now - 6 * 60 * 1000, now)).toBe(false)
    expect(isActiveRunStatus('complete', now, now)).toBe(false)
  })
})
