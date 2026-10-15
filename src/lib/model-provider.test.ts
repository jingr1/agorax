import { describe, expect, it } from 'vitest'
import {
  profileConfigPathLabel,
  readModelProviderFromConfig,
} from './model-provider'

describe('readModelProviderFromConfig', () => {
  it('reads flat model/provider strings', () => {
    expect(
      readModelProviderFromConfig({ model: 'gpt-4o', provider: 'openai' }),
    ).toEqual({ model: 'gpt-4o', provider: 'openai' })
  })

  it('reads nested model.default and model.provider', () => {
    expect(
      readModelProviderFromConfig({
        model: { default: 'Kimi-K2.7-Code', provider: 'custom:tokenx' },
        provider: 'ignored-when-nested',
      }),
    ).toEqual({ model: 'Kimi-K2.7-Code', provider: 'custom:tokenx' })
  })

  it('falls back to top-level provider when nested provider is missing', () => {
    expect(
      readModelProviderFromConfig({
        model: { default: 'llama3' },
        provider: 'ollama',
      }),
    ).toEqual({ model: 'llama3', provider: 'ollama' })
  })
})

describe('profileConfigPathLabel', () => {
  it('labels default and named profiles', () => {
    expect(profileConfigPathLabel('default')).toBe('~/.hermes/config.yaml')
    expect(profileConfigPathLabel('developer')).toBe(
      '~/.hermes/profiles/developer/config.yaml',
    )
  })
})
