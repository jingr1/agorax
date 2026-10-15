import { describe, it, expect } from 'vitest'
import { sanitizePtyEnv } from './terminal-sessions'

describe('sanitizePtyEnv', () => {
  it('keeps normal user shell vars', () => {
    const out = sanitizePtyEnv({
      HOME: '/home/user',
      PATH: '/usr/bin',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
    })
    expect(out).toEqual({
      HOME: '/home/user',
      PATH: '/usr/bin',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
    })
  })

  it('drops Cursor/VS Code shell-integration PROMPT_COMMAND so PTY does not call missing __vsc_prompt_cmd_original', () => {
    const out = sanitizePtyEnv({
      HOME: '/home/user',
      PATH: '/usr/bin',
      PROMPT_COMMAND: '__vsc_prompt_cmd_original',
      VSCODE_INJECTION: '1',
      VSCODE_SHELL_INTEGRATION: '1',
      VSCODE_IPC_HOOK_CLI: '/tmp/vscode.sock',
      CURSOR_AGENT: '1',
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.0.0',
    })
    expect(out).toEqual({
      HOME: '/home/user',
      PATH: '/usr/bin',
    })
    expect(out).not.toHaveProperty('PROMPT_COMMAND')
    expect(out).not.toHaveProperty('VSCODE_SHELL_INTEGRATION')
    expect(out).not.toHaveProperty('TERM_PROGRAM')
  })

  it('drops stacked history PROMPT_COMMAND exported from /etc/bash.bashrc under Cursor', () => {
    const out = sanitizePtyEnv({
      HOME: '/home/user',
      PROMPT_COMMAND: 'history -a; history -a; __vsc_prompt_cmd_original',
    })
    expect(out.PROMPT_COMMAND).toBeUndefined()
    expect(out.HOME).toBe('/home/user')
  })

  it('leaves TERM alone — caller sets xterm-256color after sanitize', () => {
    const out = sanitizePtyEnv({
      HOME: '/home/user',
      TERM: 'xterm-256color',
    })
    expect(out.TERM).toBe('xterm-256color')
  })

  it('skips undefined values', () => {
    const out = sanitizePtyEnv({
      HOME: '/home/user',
      EMPTY: undefined,
    })
    expect(out).toEqual({ HOME: '/home/user' })
  })
})
