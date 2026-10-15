import { describe, expect, it } from 'vitest'

import { sanitizeHttpErrorText } from './http-error'

describe('sanitizeHttpErrorText', () => {
  it('shortens Squid zero-size HTML errors', () => {
    const html =
      '<!DOCTYPE html><html><body id="ERR_ZERO_SIZE_OBJECT">proxy</body></html>'
    expect(sanitizeHttpErrorText(html)).toContain('响应为空')
  })

  it('shortens generic HTML error pages', () => {
    expect(sanitizeHttpErrorText('<html><body>502</body></html>')).toContain(
      '无效页面',
    )
  })

  it('passes through plain text errors', () => {
    expect(sanitizeHttpErrorText('gateway for learning is not healthy')).toBe(
      'gateway for learning is not healthy',
    )
  })
})
