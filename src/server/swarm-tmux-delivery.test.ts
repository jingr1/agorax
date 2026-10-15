import { describe, expect, it } from 'vitest'

import { buildHermesTmuxTuiCommand } from './swarm-tmux-delivery'

describe('buildHermesTmuxTuiCommand profile defaults', () => {
  it('starts Hermes with the profile environment', () => {
    const command = buildHermesTmuxTuiCommand({
      profilePath: '/home/user/.hermes/profiles/developer',
      hermesBin: '/usr/bin/hermes',
      useExec: true,
    })

    expect(command).not.toContain('HERMES_MODEL=')
    expect(command).not.toContain('HERMES_TUI_PROVIDER=')
    expect(command).toContain("exec '/usr/bin/hermes' chat --tui")
  })
})
