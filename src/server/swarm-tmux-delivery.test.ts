import { describe, expect, it } from 'vitest'

import {
  buildHermesTmuxTuiCommand,
  tmuxPaneLooksLikeHermesTui,
  tmuxPaneLooksLikeSharedMetricsConsent,
} from './swarm-tmux-delivery'

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

describe('shared-metrics consent pane detection', () => {
  const consentPane = `
Help improve Hermes?
Shared metrics are bounded counters...
  ↑↓ navigate  ENTER/SPACE select  ESC cancel

   (○) Collect and send to Nous
   (○) Collect locally only
 → (●) No thanks
`

  it('detects the first-run consent radiolist', () => {
    expect(tmuxPaneLooksLikeSharedMetricsConsent(consentPane)).toBe(true)
  })

  it('does not treat the consent screen as a ready TUI', () => {
    expect(tmuxPaneLooksLikeHermesTui(consentPane)).toBe(false)
  })

  it('still recognizes a ready Hermes TUI prompt', () => {
    expect(
      tmuxPaneLooksLikeHermesTui(
        'ready │ Kimi │ 9s │ 1 session\norchestrator ❯ Try "fix the lint errors"',
      ),
    ).toBe(true)
  })
})
