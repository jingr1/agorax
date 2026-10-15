import { describe, expect, it } from 'vitest'
import {
  canonicalModelAnalyticsKey,
  mergeTopModelRows,
  preferModelDisplayId,
} from './model-analytics'

describe('canonicalModelAnalyticsKey', () => {
  it('treats casing variants as the same model', () => {
    expect(canonicalModelAnalyticsKey('Kimi-K2.7-Code')).toBe(
      canonicalModelAnalyticsKey('kimi-k2.7-code'),
    )
  })

  it('ignores provider prefix', () => {
    expect(canonicalModelAnalyticsKey('minimaxai/minimax-m2.7')).toBe(
      canonicalModelAnalyticsKey('minimax-m2.7'),
    )
  })

  it('keeps distinct variants separate', () => {
    expect(canonicalModelAnalyticsKey('Kimi-K2.7-Code')).not.toBe(
      canonicalModelAnalyticsKey('Kimi-K2.7-Code-Tencent'),
    )
  })
})

describe('preferModelDisplayId', () => {
  it('prefers mixed-case id', () => {
    expect(preferModelDisplayId('kimi-k2.7-code', 'Kimi-K2.7-Code')).toBe(
      'Kimi-K2.7-Code',
    )
  })
})

describe('mergeTopModelRows', () => {
  it('merges duplicate logical models', () => {
    const merged = mergeTopModelRows([
      {
        id: 'Kimi-K2.7-Code',
        tokens: 100,
        calls: 10,
        cost: 1,
        sessions: 10,
      },
      {
        id: 'kimi-k2.7-code',
        tokens: 50,
        calls: 5,
        cost: 0.5,
        sessions: 5,
      },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('Kimi-K2.7-Code')
    expect(merged[0].tokens).toBe(150)
    expect(merged[0].calls).toBe(15)
  })
})
