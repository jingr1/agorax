import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useComposerDraft } from './use-composer-draft'

afterEach(() => sessionStorage.clear())
it('preserves independent session drafts and clears only the submitted session', () => {
  const { result, rerender, unmount } = renderHook(({ sessionKey }) => useComposerDraft(sessionKey), { initialProps: { sessionKey: 'one' } })
  act(() => { result.current.setValue('First'); result.current.persistDraft('First') })
  rerender({ sessionKey: 'two' })
  expect(result.current.value).toBe('')
  act(() => { result.current.setValue('Second'); result.current.persistDraft('Second') })
  rerender({ sessionKey: 'one' })
  expect(result.current.value).toBe('First')
  act(() => result.current.clearDraft())
  expect(sessionStorage.getItem('claude-draft-one')).toBeNull()
  expect(sessionStorage.getItem('claude-draft-two')).toBe('Second')
  unmount()
})