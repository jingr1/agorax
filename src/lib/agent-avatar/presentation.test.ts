import { describe, expect, it } from 'vitest'
import {
  agentNameInitials,
  countAgentsByProvider,
  normalizeAgentAvatarProvider,
  projectAgentIdentityAvatar,
  resolveAgentAvatarSrc,
} from './presentation'

describe('normalizeAgentAvatarProvider', () => {
  it('maps known runtimes and aliases', () => {
    expect(normalizeAgentAvatarProvider('hermes')).toBe('hermes')
    expect(normalizeAgentAvatarProvider('claude-code')).toBe('claude-code')
    expect(normalizeAgentAvatarProvider('cc-impl')).toBe('claude-code')
    expect(normalizeAgentAvatarProvider('codex-impl')).toBe('codex')
    expect(normalizeAgentAvatarProvider('cursor-impl')).toBe('cursor')
    expect(normalizeAgentAvatarProvider('opencode-impl')).toBe('opencode')
    expect(normalizeAgentAvatarProvider('kimi-impl')).toBe('kimi')
    expect(normalizeAgentAvatarProvider('kimi-code')).toBe('kimi')
    expect(normalizeAgentAvatarProvider('agorax')).toBe('agorax')
  })

  it('falls back for unknown runtimes', () => {
    expect(normalizeAgentAvatarProvider('mystery')).toBe('fallback')
    expect(normalizeAgentAvatarProvider(undefined)).toBe('fallback')
    expect(resolveAgentAvatarSrc('mystery')).toBe(
      '/agent-avatars/agorax-rounded.png',
    )
  })
})

describe('agentNameInitials', () => {
  it('uses first letters of the first two words', () => {
    expect(agentNameInitials('Claude Code')).toBe('CC')
    expect(agentNameInitials('GPU Server')).toBe('GS')
  })

  it('uses the first two graphemes of a single word', () => {
    expect(agentNameInitials('Orchestrator')).toBe('OR')
    expect(agentNameInitials('Aider')).toBe('AI')
    expect(agentNameInitials('kimi')).toBe('KI')
  })

  it('handles empty and hyphenated names', () => {
    expect(agentNameInitials('')).toBe('??')
    expect(agentNameInitials('deepseek-harness')).toBe('DH')
  })
})

describe('projectAgentIdentityAvatar', () => {
  it('hides initials when the provider has a single agent', () => {
    const result = projectAgentIdentityAvatar({
      name: 'Codex',
      runtime: 'codex',
      providerSiblingCount: 1,
    })
    expect(result.initials).toBeNull()
    expect(result.src).toBe('/agent-avatars/codex-rounded.png')
  })

  it('shows two-letter initials when the provider has siblings', () => {
    const result = projectAgentIdentityAvatar({
      name: 'Researcher',
      runtime: 'hermes',
      providerSiblingCount: 6,
    })
    expect(result.provider).toBe('hermes')
    expect(result.initials).toBe('RE')
    expect(result.src).toBe('/agent-avatars/hermes-rounded.png')
  })

  it('uses kimi and deepseek provider art', () => {
    expect(resolveAgentAvatarSrc('kimi')).toBe('/agent-avatars/kimi-rounded.png')
    expect(resolveAgentAvatarSrc('kimi-code')).toBe(
      '/agent-avatars/kimi-rounded.png',
    )
    expect(resolveAgentAvatarSrc('deepseek-harness')).toBe(
      '/agent-avatars/deepseek-rounded.png',
    )
  })

  it('respects an explicit showInitials override', () => {
    expect(
      projectAgentIdentityAvatar({
        name: 'Codex',
        runtime: 'codex',
        providerSiblingCount: 1,
        showInitials: true,
      }).initials,
    ).toBe('CO')
    expect(
      projectAgentIdentityAvatar({
        name: 'Researcher',
        runtime: 'hermes',
        providerSiblingCount: 6,
        showInitials: false,
      }).initials,
    ).toBeNull()
  })
})

describe('countAgentsByProvider', () => {
  it('aggregates by normalized provider key', () => {
    const counts = countAgentsByProvider([
      { runtime: 'hermes' },
      { runtime: 'hermes' },
      { runtime: 'codex' },
      { runtime: 'codex-impl' },
    ])
    expect(counts.get('hermes')).toBe(2)
    expect(counts.get('codex')).toBe(2)
  })
})

describe('resolveAgentAvatarSrc', () => {
  it('returns the circular asset path for a runtime', () => {
    expect(resolveAgentAvatarSrc('cursor')).toBe(
      '/agent-avatars/cursor-rounded.png',
    )
  })
})
