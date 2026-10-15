import { beforeEach, describe, expect, it } from 'vitest'
import {
  getActiveSendRunHandle,
  hasActiveSendRun,
  interruptActiveSendRun,
  interruptActiveSendRunsForSession,
  registerActiveSendRun,
  resetActiveSendRunsForTests,
  unregisterActiveSendRun,
} from './send-run-tracker'

describe('send-run-tracker interrupt handles', () => {
  beforeEach(() => {
    resetActiveSendRunsForTests()
  })

  it('registers and interrupts a live upstream abort handle', () => {
    let aborted = false
    registerActiveSendRun('run-1', {
      sessionKey: 'session-a',
      abortUpstream: () => {
        aborted = true
      },
    })
    expect(hasActiveSendRun('run-1')).toBe(true)
    expect(getActiveSendRunHandle('run-1')?.sessionKey).toBe('session-a')
    expect(interruptActiveSendRun('run-1')).toBe(true)
    expect(aborted).toBe(true)
  })

  it('interrupts every live handle for a session', () => {
    const aborted: Array<string> = []
    registerActiveSendRun('run-1', {
      sessionKey: 'session-a',
      abortUpstream: () => aborted.push('run-1'),
    })
    registerActiveSendRun('run-2', {
      sessionKey: 'session-a',
      abortUpstream: () => aborted.push('run-2'),
    })
    registerActiveSendRun('run-other', {
      sessionKey: 'session-b',
      abortUpstream: () => aborted.push('run-other'),
    })
    expect(interruptActiveSendRunsForSession('session-a').sort()).toEqual([
      'run-1',
      'run-2',
    ])
    expect(aborted.sort()).toEqual(['run-1', 'run-2'])
  })

  it('unregisters handles so later interrupt is a no-op', () => {
    let aborted = false
    registerActiveSendRun('run-1', {
      sessionKey: 'session-a',
      abortUpstream: () => {
        aborted = true
      },
    })
    unregisterActiveSendRun('run-1')
    expect(hasActiveSendRun('run-1')).toBe(false)
    expect(interruptActiveSendRun('run-1')).toBe(false)
    expect(aborted).toBe(false)
  })
})
