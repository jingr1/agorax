import { afterEach, describe, expect, it, vi } from 'vitest'
import { isImeKeyEvent, scheduleImeComposingClear } from './ime-enter'

describe('isImeKeyEvent', () => {
  it('treats isComposing as IME', () => {
    expect(isImeKeyEvent({ isComposing: true })).toBe(true)
  })

  it('treats keyCode 229 as IME even when isComposing is false', () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(isImeKeyEvent({ isComposing: false, which: 229 })).toBe(true)
  })

  it('honors the post-compositionend flag', () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 }, true)).toBe(
      true,
    )
  })

  it('returns false for a plain Enter', () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})

describe('scheduleImeComposingClear', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears on the next macrotask so trailing Enter still sees the flag', () => {
    vi.useFakeTimers()
    const clear = vi.fn()
    scheduleImeComposingClear(clear)
    expect(clear).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('cancel prevents the deferred clear', () => {
    vi.useFakeTimers()
    const clear = vi.fn()
    const cancel = scheduleImeComposingClear(clear)
    cancel()
    vi.runAllTimers()
    expect(clear).not.toHaveBeenCalled()
  })
})
