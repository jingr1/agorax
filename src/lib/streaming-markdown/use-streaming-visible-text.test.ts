// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { advanceStreamingVisibleText } from './use-streaming-visible-text'

describe('advanceStreamingVisibleText', () => {
  it('advances by charsPerFrame along a growing prefix', () => {
    const next = advanceStreamingVisibleText({
      visibleText: 'hel',
      sourceText: 'hello world',
      frameMs: 24,
      maxCharsPerSecond: 6000,
    })
    // ceil(6000*24/1000) = 144, so catches up in one frame for short strings
    expect(next).toBe('hello world')
  })

  it('preserves common prefix on rewrite', () => {
    const next = advanceStreamingVisibleText({
      visibleText: 'hello there',
      sourceText: 'hello world!',
      frameMs: 1000,
      maxCharsPerSecond: 5,
    })
    // common prefix "hello ", then +5 chars → "hello world"
    expect(next.startsWith('hello ')).toBe(true)
    expect(next.length).toBe('hello '.length + 5)
  })

  it('returns source when already caught up', () => {
    expect(
      advanceStreamingVisibleText({
        visibleText: 'done',
        sourceText: 'done',
      }),
    ).toBe('done')
  })
})
