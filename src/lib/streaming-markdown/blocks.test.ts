// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  hashMarkdownBlockContent,
  hasOpenPotentialMermaidFence,
  splitStreamingMarkdownBlocks,
} from './blocks'

describe('splitStreamingMarkdownBlocks', () => {
  it('splits on blank lines outside fences', () => {
    const blocks = splitStreamingMarkdownBlocks('para one\n\npara two\n')
    expect(blocks.map((b) => b.content)).toEqual(['para one\n', 'para two\n'])
  })

  it('does not split inside an open fence', () => {
    const blocks = splitStreamingMarkdownBlocks(
      'intro\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter\n',
    )
    expect(blocks).toHaveLength(3)
    expect(blocks[0]?.content).toBe('intro\n')
    expect(blocks[1]?.content).toContain('```ts')
    expect(blocks[1]?.content).toContain('const b = 2')
    expect(blocks[2]?.content).toBe('after\n')
  })

  it('keeps a growing open fence as a single trailing block', () => {
    const mid = splitStreamingMarkdownBlocks('```js\nconsole.log(1)\n')
    expect(mid).toHaveLength(1)
    expect(mid[0]?.content).toContain('```js')
    const closed = splitStreamingMarkdownBlocks(
      '```js\nconsole.log(1)\n```\n\nok',
    )
    expect(closed).toHaveLength(2)
    expect(closed[0]?.initialKeyContent).toContain('```js')
    expect(closed[1]?.content).toBe('ok')
  })

  it('hashes content stably for keys', () => {
    expect(hashMarkdownBlockContent('abc')).toBe(hashMarkdownBlockContent('abc'))
    expect(hashMarkdownBlockContent('abc')).not.toBe(
      hashMarkdownBlockContent('abd'),
    )
  })

  it('detects open mermaid fences', () => {
    expect(hasOpenPotentialMermaidFence('```mermaid\ngraph TD\n')).toBe(true)
    expect(
      hasOpenPotentialMermaidFence('```mermaid\ngraph TD\nA-->B\n```\n'),
    ).toBe(false)
  })
})
