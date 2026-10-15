import { marked } from 'marked'
import { describe, expect, it } from 'vitest'

import { normalizeMathDelimiters } from '@/lib/markdown-math'

describe('normalizeMathDelimiters', () => {
  it('rewrites backslash display delimiters to $$ blocks', () => {
    const input = `\\[
\\text{SoundPower}(f)=10\\log_{10}(x)
\\]`
    expect(normalizeMathDelimiters(input)).toBe(
      `$$\n\\text{SoundPower}(f)=10\\log_{10}(x)\n$$`,
    )
  })

  it('rewrites backslash inline delimiters to $...$', () => {
    expect(normalizeMathDelimiters('where \\(L_i(f)\\) = SPL')).toBe(
      'where $L_i(f)$ = SPL',
    )
  })

  it('keeps nested brackets inside a display matrix', () => {
    const input = `\\[
F' = \\begin{bmatrix}
[0.5, \\ 0.2] & \\text{位置 1} \\\\
[0.1, \\ 0.8] & \\text{位置 2} \\\\
[-0.4, \\ 0.6] & \\text{位置 3}
\\end{bmatrix}
\\]`
    const result = normalizeMathDelimiters(input)
    expect(result.startsWith('$$\n')).toBe(true)
    expect(result.endsWith('\n$$')).toBe(true)
    expect(result).toContain('\\begin{bmatrix}')
    expect(result).not.toContain('\\[')
    expect(result).not.toContain('\\]')
  })

  it('does not treat bare [brackets] as math', () => {
    const input = 'See [link](https://example.com) and [0.5, 0.2].'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('leaves fenced code containing latex delimiters untouched', () => {
    const input = '```\n\\[ a + b \\] is wrong\n\\(L_i\\) too\n$$matrix$$\n```'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('leaves inline code containing latex delimiters untouched', () => {
    const input = 'Use `\\[x\\]` and `$x$` in source.'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('preserves already-valid $$ and $ delimiters', () => {
    const input = 'Inline $H = 3$ and\n\n$$\nE = mc^2\n$$'
    expect(normalizeMathDelimiters(input)).toBe(input)
  })

  it('escapes dollar pairs that look like table cells', () => {
    expect(normalizeMathDelimiters('$foo | bar$')).toBe('\\$foo | bar\\$')
  })

  it('leaves currency amounts unchanged', () => {
    expect(normalizeMathDelimiters('costs $5 and $10')).toBe('costs $5 and $10')
  })

  it('keeps a converted display block in one marked token', () => {
    const input = `\\[
F' = \\begin{bmatrix}
[0.5, 0.2] \\\\
[0.1, 0.8]
\\end{bmatrix}
\\]`
    const tokens = marked.lexer(normalizeMathDelimiters(input))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.raw).toContain('$$')
    expect(tokens[0]?.raw).toContain('\\begin{bmatrix}')
  })
})
