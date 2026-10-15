// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { stabilizeStreamingMarkdownTail } from './tail-stabilizer'

describe('stabilizeStreamingMarkdownTail', () => {
  it('is a no-op when not streaming', () => {
    expect(
      stabilizeStreamingMarkdownTail('```js\nfoo', { streaming: false }),
    ).toEqual({ content: '```js\nfoo', changed: false })
  })

  it('closes an open fence', () => {
    const result = stabilizeStreamingMarkdownTail('```ts\nconst x = 1\n', {
      streaming: true,
    })
    expect(result.changed).toBe(true)
    expect(result.reason).toBe('open-fence')
    expect(result.content.endsWith('\n```')).toBe(true)
  })

  it('strips incomplete link labels to plain text', () => {
    const result = stabilizeStreamingMarkdownTail('See [docs', {
      streaming: true,
    })
    expect(result.changed).toBe(true)
    expect(result.content).toBe('See docs')
  })

  it('drops dangling list markers', () => {
    const result = stabilizeStreamingMarkdownTail('items:\n-', {
      streaming: true,
    })
    expect(result.changed).toBe(true)
    expect(result.content).toBe('items:\n')
  })
})
