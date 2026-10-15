import { describe, expect, it } from 'vitest'
import { highlightWithPrism } from './prism-highlight'

describe('highlightWithPrism', () => {
  it('highlights bash comments and commands synchronously', () => {
    const html = highlightWithPrism('# comment\ndocker exec -it foo', 'bash')
    expect(html).toContain('token')
    expect(html).toContain('comment')
    expect(html).toContain('docker')
  })

  it('escapes plain text without grammar', () => {
    const html = highlightWithPrism('<script>alert(1)</script>', 'text')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
