import { describe, expect, it } from 'vitest'
import {
  AGENT_PROVIDER_BADGE_LABELS,
  providerIdForAgentRuntime,
  providerStatusBadge,
} from './provider-status'

describe('providerStatusBadge', () => {
  it('returns unknown when entry is missing', () => {
    expect(providerStatusBadge(undefined)).toBe('unknown')
  })

  it('returns not-installed when the binary is missing', () => {
    expect(
      providerStatusBadge({ installed: false, updateAvailable: false }),
    ).toBe('not-installed')
  })

  it('returns update-available even when installed', () => {
    expect(
      providerStatusBadge({ installed: true, updateAvailable: true }),
    ).toBe('update-available')
  })

  it('returns ready for a satisfied runtime', () => {
    expect(
      providerStatusBadge({ installed: true, updateAvailable: false }),
    ).toBe('ready')
  })

  it('returns unknown when the probe reports an error', () => {
    expect(
      providerStatusBadge({ installed: true, updateAvailable: false, error: 'probe failed' }),
    ).toBe('unknown')
  })
})

describe('providerIdForAgentRuntime', () => {
  it('maps managed runtimes to daemon provider ids', () => {
    expect(providerIdForAgentRuntime('claude-code')).toBe('claude-code')
    expect(providerIdForAgentRuntime('codex')).toBe('codex')
    expect(providerIdForAgentRuntime('cursor')).toBe('cursor')
    expect(providerIdForAgentRuntime('opencode')).toBe('opencode')
    expect(providerIdForAgentRuntime('kimi')).toBe('kimi-code')
  })

  it('returns null for runtimes without daemon detection', () => {
    expect(providerIdForAgentRuntime('hermes')).toBeNull()
    expect(providerIdForAgentRuntime('deepseek-harness')).toBeNull()
  })
})

describe('AGENT_PROVIDER_BADGE_LABELS', () => {
  it('covers every badge state', () => {
    expect(AGENT_PROVIDER_BADGE_LABELS.ready).toBe('就绪')
    expect(AGENT_PROVIDER_BADGE_LABELS['update-available']).toBe('需升级')
    expect(AGENT_PROVIDER_BADGE_LABELS['not-installed']).toBe('未安装')
    expect(AGENT_PROVIDER_BADGE_LABELS.unknown).toBe('未知')
  })
})
