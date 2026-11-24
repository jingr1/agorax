/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyAgentPreferences,
  formatAgentPreferencesBlock,
  hasAgentPreferences,
  stripAgentPreferences,
} from './apply'
import { resetAgentPreferencesCacheForTests } from './load'

afterEach(() => {
  delete process.env.AGORAX_AGENT_PREFERENCES_TEXT
  delete process.env.AGORAX_AGENT_PREFERENCES_PATH
  resetAgentPreferencesCacheForTests()
})

describe('applyAgentPreferences', () => {
  it('prepends a marked block from env text', () => {
    process.env.AGORAX_AGENT_PREFERENCES_TEXT = 'Be brief.'
    resetAgentPreferencesCacheForTests()
    const out = applyAgentPreferences('hello')
    expect(out).toContain('<!-- agorax-agent-preferences -->')
    expect(out).toContain('Be brief.')
    expect(out).toContain('<!-- /agorax-agent-preferences -->')
    expect(out.endsWith('hello')).toBe(true)
  })

  it('is idempotent when the marker is already present', () => {
    process.env.AGORAX_AGENT_PREFERENCES_TEXT = 'Be brief.'
    resetAgentPreferencesCacheForTests()
    const once = applyAgentPreferences('hello')
    expect(applyAgentPreferences(once)).toBe(once)
  })

  it('skips injection when preferences are empty', () => {
    process.env.AGORAX_AGENT_PREFERENCES_TEXT = '   '
    resetAgentPreferencesCacheForTests()
    expect(applyAgentPreferences('hello')).toBe('hello')
  })

  it('strips the injected block for display', () => {
    const block = formatAgentPreferencesBlock('Be brief.')
    const raw = `${block}\n\nhello`
    expect(hasAgentPreferences(raw)).toBe(true)
    expect(stripAgentPreferences(raw)).toBe('hello')
  })
})
