import { describe, expect, it } from 'vitest'
import {
  clearRunDetached,
  isRunDetached,
  markRunDetached,
  resolveClientDisconnectAction,
} from './stream-handoff-registry'

describe('stream-handoff-registry', () => {
  it('marks and detects detached runs', () => {
    clearRunDetached('run-a')
    expect(isRunDetached('run-a')).toBe(false)
    markRunDetached('run-a')
    expect(isRunDetached('run-a')).toBe(true)
    clearRunDetached('run-a')
    expect(isRunDetached('run-a')).toBe(false)
  })

  it('resolves detach handoff only for registered runs', () => {
    clearRunDetached('run-b')
    expect(resolveClientDisconnectAction({ runId: 'run-b' })).toBe(
      'abort_upstream',
    )
    markRunDetached('run-b')
    expect(resolveClientDisconnectAction({ runId: 'run-b' })).toBe(
      'detach_handoff',
    )
    clearRunDetached('run-b')
  })
})
