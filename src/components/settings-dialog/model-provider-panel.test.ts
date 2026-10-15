import { describe, expect, it } from 'vitest'
import {
  getOAuthStartButtonLabel,
  getProviderCardStatus,
  getProviderClickAction,
  isProviderKeyConfigured,
  mergeProviderCards,
} from './model-provider-panel'

describe('mergeProviderCards', () => {
  it('appends catalog providers after built-in cards', () => {
    const cards = mergeProviderCards([
      { id: 'tokenx', name: 'TokenX', base_url: 'https://model.example/v1' },
      { id: 'ollama', name: 'Ollama duplicate' },
    ])
    const ids = cards.map((card) => card.id)
    expect(ids.indexOf('tokenx')).toBeGreaterThan(ids.indexOf('xiaomi'))
    expect(ids).toContain('tokenx')
    expect(ids).not.toContain('custom')
    expect(ids.filter((id) => id === 'ollama')).toHaveLength(1)
  })
})

describe('getProviderClickAction', () => {
  it('routes oauth and local providers', () => {
    expect(
      getProviderClickAction({
        providerId: 'nous',
        authType: 'oauth',
        hasKey: false,
      }),
    ).toBe('oauth')
    expect(
      getProviderClickAction({
        providerId: 'ollama',
        authType: 'none',
        hasKey: true,
      }),
    ).toBe('local')
  })

  it('selects keyed providers and ignores missing keys', () => {
    expect(
      getProviderClickAction({
        providerId: 'anthropic',
        authType: 'api_key',
        hasKey: true,
      }),
    ).toBe('select')
    expect(
      getProviderClickAction({
        providerId: 'anthropic',
        authType: 'api_key',
        hasKey: false,
      }),
    ).toBe('ignore')
  })
})

describe('getOAuthStartButtonLabel', () => {
  it('shows waiting while the flow is in progress', () => {
    expect(getOAuthStartButtonLabel('idle')).toBe('Start OAuth')
    expect(getOAuthStartButtonLabel('starting')).toBe('Waiting...')
    expect(getOAuthStartButtonLabel('pending')).toBe('Waiting...')
  })
})

describe('isProviderKeyConfigured', () => {
  it('requires a real env value for builtin cards', () => {
    expect(
      isProviderKeyConfigured(
        { envKey: 'DEEPSEEK_API_KEY', keyConfigured: false },
        {},
      ),
    ).toBe(false)
    expect(
      isProviderKeyConfigured(
        { envKey: 'DEEPSEEK_API_KEY', keyConfigured: false },
        { DEEPSEEK_API_KEY: '••••' },
      ),
    ).toBe(true)
  })
})

describe('getProviderCardStatus', () => {
  it('shows Key required for builtin providers without a configured env key', () => {
    expect(
      getProviderCardStatus(
        {
          id: 'deepseek',
          source: 'builtin',
          authType: 'api_key',
          envKey: 'DEEPSEEK_API_KEY',
          keyConfigured: false,
        },
        {},
      ),
    ).toMatchObject({ label: 'Key required', verified: false, hasKey: false })
  })

  it('shows Key set for catalog providers with configured keys', () => {
    expect(
      getProviderCardStatus(
        {
          id: 'tokenx',
          source: 'catalog',
          authType: 'api_key',
          envKey: 'TOKENX_API_KEY',
          keyConfigured: true,
          baseUrl: 'https://model.example/v1',
        },
        { TOKENX_API_KEY: '••••' },
      ),
    ).toMatchObject({ label: 'Key set', verified: true, hasKey: true })
  })
})
