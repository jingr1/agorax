// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeContextUsageOverride } from './context-indicator'

describe('normalizeContextUsageOverride', () => {
  it('returns null when maxTokens is missing or zero', () => {
    expect(normalizeContextUsageOverride(null)).toBeNull()
    expect(
      normalizeContextUsageOverride({ usedTokens: 10, maxTokens: 0 }),
    ).toBeNull()
  })

  it('derives contextPercent from used/max when omitted', () => {
    const snap = normalizeContextUsageOverride({
      usedTokens: 110,
      maxTokens: 1000,
    })
    expect(snap).toMatchObject({
      usedTokens: 110,
      maxTokens: 1000,
      contextPercent: 11,
    })
  })

  it('preserves an explicit contextPercent', () => {
    const snap = normalizeContextUsageOverride({
      usedTokens: 100,
      maxTokens: 1000,
      contextPercent: 42.5,
    })
    expect(snap?.contextPercent).toBe(42.5)
  })
})

describe('managed context wiring', () => {
  it('feeds ContextIndicator from managed contextUsage and keeps Context out of topNotices', () => {
    const managed = readFileSync(
      resolve(
        process.cwd(),
        'src/screens/chat/components/managed-agent-chat-view.tsx',
      ),
      'utf8',
    )
    const composer = readFileSync(
      resolve(process.cwd(), 'src/screens/chat/components/chat-composer.tsx'),
      'utf8',
    )
    const indicator = readFileSync(
      resolve(process.cwd(), 'src/screens/chat/components/context-indicator.tsx'),
      'utf8',
    )

    expect(managed).toContain('contextUsage')
    expect(managed).not.toContain('`Context ${')
    expect(managed).toContain('Files ${')
    expect(composer).toContain('usage={contextUsage}')
    expect(indicator).toContain('if (external) return')
  })
})
