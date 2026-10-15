import { describe, expect, it } from 'vitest'
import {
  catalogFromConfig,
  listConfigReferencedProviders,
  listConfiguredBuiltinProviders,
  listModelCatalogProviders,
  mergeModelEntries,
  modelsFromBuiltinPresets,
  modelsFromProviderCache,
} from './models'

describe('mergeModelEntries', () => {
  it('keeps local catalog entries and appends Hermes backend models without duplicates', () => {
    const merged = mergeModelEntries(
      [
        {
          id: 'workspace/default',
          name: 'Workspace default',
          provider: 'workspace',
        },
        {
          id: 'openai/gpt-4.1',
          name: 'GPT-4.1 from local catalog',
          provider: 'openai',
        },
      ],
      [
        {
          id: 'openai/gpt-4.1',
          name: 'GPT-4.1 from Hermes',
          provider: 'openai',
        },
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet',
          provider: 'anthropic',
        },
      ],
    )

    expect(merged.map((model) => model.id)).toEqual([
      'workspace/default',
      'openai/gpt-4.1',
      'anthropic/claude-sonnet-4.5',
    ])
    expect(merged[1]?.name).toBe('GPT-4.1 from local catalog')
  })

  it('normalizes string model ids from Hermes-compatible /v1/models responses', () => {
    expect(mergeModelEntries(['openrouter/qwen/qwen3-coder'] as any)).toEqual([
      {
        id: 'openrouter/qwen/qwen3-coder',
        name: 'openrouter/qwen/qwen3-coder',
        provider: 'openrouter',
      },
    ])
  })
})

describe('catalogFromConfig', () => {
  it('includes custom_providers map-form models and fallback providers', () => {
    const catalog = catalogFromConfig({
      providers: {},
      fallback_providers: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
      custom_providers: [
        {
          name: 'moonshot-coding-plan',
          default_model: 'kimi-for-coding',
          models: {
            'kimi-for-coding': { context_length: 262144 },
            'kimi-for-coding-highspeed': { context_length: 262144 },
            'k3-256k': { context_length: 262144 },
            k3: { context_length: 1048576 },
          },
        },
      ],
    })

    expect(catalog.map((model) => model.id)).toEqual([
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
      'k3-256k',
      'k3',
      'deepseek-v4-pro',
    ])
    expect(catalog.find((m) => m.id === 'k3')?.provider).toBe(
      'moonshot-coding-plan',
    )
    expect(catalog.find((m) => m.id === 'k3')?.context_length).toBe(1048576)
  })

  it('accepts providers.*.models as either array or map', () => {
    const catalog = catalogFromConfig({
      providers: {
        nvidia: {
          models: [
            'minimaxai/minimax-m2.5',
            { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5' },
          ],
        },
        local: {
          models: {
            'qwen3:8b': { name: 'Qwen3 8B' },
          },
        },
      },
    })

    expect(catalog.map((model) => model.id)).toEqual([
      'minimaxai/minimax-m2.5',
      'moonshotai/kimi-k2.5',
      'qwen3:8b',
    ])
    expect(catalog.find((m) => m.id === 'qwen3:8b')?.name).toBe('Qwen3 8B')
  })
})

describe('provider models cache expansion', () => {
  it('lists deepseek from fallback_providers as a referenced provider', () => {
    expect(
      listConfigReferencedProviders({
        model: { provider: 'moonshot-coding-plan', default: 'kimi-for-coding' },
        fallback_providers: [
          { provider: 'deepseek', model: 'deepseek-v4-pro' },
        ],
      }),
    ).toEqual(['moonshot-coding-plan', 'deepseek'])
  })

  it('expands deepseek cache models for config-referenced providers only', () => {
    const models = modelsFromProviderCache(
      {
        deepseek: {
          models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
        },
        nvidia: {
          models: ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b'],
        },
      },
      ['deepseek'],
    )

    expect(models.map((model) => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ])
    expect(models.every((model) => model.provider === 'deepseek')).toBe(true)
  })

  it('includes configured builtin providers without config.yaml references', () => {
    expect(
      listModelCatalogProviders(
        {
          model: {
            provider: 'moonshot-coding-plan',
            default: 'kimi-for-coding',
          },
          fallback_providers: [
            { provider: 'deepseek', model: 'deepseek-v4-pro' },
          ],
        },
        { NVIDIA_API_KEY: 'nvapi-test', DEEPSEEK_API_KEY: 'sk-test' },
      ).sort(),
    ).toEqual(['deepseek', 'moonshot-coding-plan', 'nvidia'].sort())

    const models = mergeModelEntries(
      modelsFromProviderCache(
        {
          nvidia: {
            models: ['nvidia/nemotron-3-super-120b-a12b'],
          },
        },
        listConfiguredBuiltinProviders({ NVIDIA_API_KEY: 'nvapi-test' }),
      ),
      modelsFromBuiltinPresets(['nvidia']),
    )

    expect(models.map((model) => model.id)).toContain(
      'nvidia/nemotron-3-super-120b-a12b',
    )
    expect(models.map((model) => model.id)).toContain(
      'nvidia/llama-3.3-nemotron-super-49b-v1',
    )
  })
})
