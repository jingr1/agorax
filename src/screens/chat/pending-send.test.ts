import { afterEach, describe, expect, it } from 'vitest'
import {
  hasPendingGeneration,
  isRecentSession,
  resetPendingSend,
  setPendingGeneration,
  setRecentSession,
} from './pending-send'

describe('setRecentSession', () => {
  afterEach(() => {
    resetPendingSend()
    setRecentSession('')
  })

  it('keeps a just-created session visible across list refetches', () => {
    const id = 'thread-new-1'
    setRecentSession(id)
    expect(isRecentSession(id)).toBe(true)
    expect(isRecentSession('other')).toBe(false)
  })

  it('expires after the configured window', () => {
    const id = 'thread-new-2'
    setRecentSession(id)
    expect(isRecentSession(id, 0)).toBe(false)
  })
})

describe('pendingGeneration session scope', () => {
  afterEach(() => {
    resetPendingSend()
  })

  it('does not leak pending generation across sessions', () => {
    setPendingGeneration(true, {
      sessionKey: 'sess-a',
      friendlyId: 'friendly-a',
    })
    expect(
      hasPendingGeneration({
        sessionKey: 'sess-a',
        friendlyId: 'friendly-a',
      }),
    ).toBe(true)
    expect(
      hasPendingGeneration({
        sessionKey: 'new',
        friendlyId: 'new',
      }),
    ).toBe(false)
    expect(hasPendingGeneration({ friendlyId: 'new' })).toBe(false)
  })

  it('clears only the targeted session identity', () => {
    setPendingGeneration(true, {
      sessionKey: 'sess-a',
      friendlyId: 'friendly-a',
    })
    setPendingGeneration(true, {
      sessionKey: 'sess-b',
      friendlyId: 'friendly-b',
    })
    setPendingGeneration(false, {
      sessionKey: 'sess-a',
      friendlyId: 'friendly-a',
    })
    expect(hasPendingGeneration({ sessionKey: 'sess-a' })).toBe(false)
    expect(hasPendingGeneration({ sessionKey: 'sess-b' })).toBe(true)
  })
})
