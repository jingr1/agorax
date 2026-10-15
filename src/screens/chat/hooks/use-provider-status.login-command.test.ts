// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { wrapLoginKeepaliveCommand } from './use-provider-status'

describe('wrapLoginKeepaliveCommand', () => {
  it('wraps argv in bash -lc that keeps a shell after the login CLI exits', () => {
    const wrapped = wrapLoginKeepaliveCommand(['claude', 'auth', 'login'])
    expect(wrapped[0]).toBe('bash')
    expect(wrapped[1]).toBe('-lc')
    expect(wrapped[2]).toContain("'claude' 'auth' 'login'")
    expect(wrapped[2]).toContain('exec bash -l')
    expect(wrapped[2]).toContain('login finished')
  })

  it('escapes single quotes inside argv tokens', () => {
    const wrapped = wrapLoginKeepaliveCommand(["it's", 'fine'])
    expect(wrapped[2]).toContain(`'it'\\''s' 'fine'`)
  })
})
