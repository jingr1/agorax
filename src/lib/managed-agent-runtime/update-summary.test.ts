import { describe, expect, it } from 'vitest'
import type { AgentProviderStatusDto } from './provider-status'
import {
  formatAgentProviderUpdateSummary,
  resolveAgentProviderUpdateRowPresentation,
} from './update-summary'

function entry(
  overrides: Partial<AgentProviderStatusDto> = {},
): AgentProviderStatusDto {
  return {
    provider: 'codex',
    targetId: 'local:codex',
    registered: true,
    installed: true,
    version: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    auth: { status: 'authenticated' },
    update: { capability: 'supported', source: 'npm' },
    ...overrides,
  }
}

describe('resolveAgentProviderUpdateRowPresentation', () => {
  it('flags checkFailed when discovery ran with a reasonCode', () => {
    const presentation = resolveAgentProviderUpdateRowPresentation(
      entry({
        updateAvailable: false,
        latestVersion: null,
        update: {
          capability: 'supported',
          source: 'npm',
          lastCheckedAt: '2026-09-24T00:00:00Z',
          reasonCode: 'registry_unreachable',
        },
      }),
    )
    expect(presentation.checkFailed).toBe(true)
    expect(presentation.currentVersion).toBe('0.1.0')
  })

  it('prefers update.currentVersion / update.latestVersion when present', () => {
    const presentation = resolveAgentProviderUpdateRowPresentation(
      entry({
        version: '1.0.0',
        latestVersion: '1.1.0',
        update: {
          capability: 'supported',
          currentVersion: '2.0.0',
          latestVersion: '2.1.0',
        },
      }),
    )
    expect(presentation.currentVersion).toBe('2.0.0')
    expect(presentation.latestVersion).toBe('2.1.0')
  })
})

describe('formatAgentProviderUpdateSummary', () => {
  it('formats update available as current → latest', () => {
    expect(
      formatAgentProviderUpdateSummary({
        checkFailed: false,
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        updateAvailable: true,
      }),
    ).toBe('1.0.0 → 1.2.0')
  })

  it('formats check failed with current version', () => {
    expect(
      formatAgentProviderUpdateSummary({
        checkFailed: true,
        currentVersion: '1.0.0',
        latestVersion: null,
        updateAvailable: false,
      }),
    ).toBe('1.0.0 · 暂时无法检查')
  })

  it('formats up-to-date when both versions match', () => {
    expect(
      formatAgentProviderUpdateSummary({
        checkFailed: false,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      }),
    ).toBe('1.0.0（已是最新）')
  })
})
