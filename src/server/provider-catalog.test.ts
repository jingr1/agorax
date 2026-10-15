import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCatalogProviderCredential,
  getProviderCatalog,
  isBuiltinCatalogProvider,
  listCatalogProvidersForClaudeCode,
  readProfileProviderSelection,
  removeCatalogProvider,
  updateProfileFallback,
  upsertCatalogKey,
  upsertCatalogProvider,
  __resetProviderCatalogCacheForTests,
} from './provider-catalog'
import { readProfile } from './profiles-browser'

describe('provider catalog', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hermes-workspace-catalog-'),
    )
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
    process.env.HERMES_HOME = path.join(tempHome, '.hermes')
    process.env.AGORAX_STATE_DIR = path.join(
      tempHome,
      '.hermes',
      'workspace',
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetProviderCatalogCacheForTests()
    delete process.env.HERMES_HOME
    delete process.env.AGORAX_STATE_DIR
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  function seedProfiles() {
    const hermesRoot = path.join(tempHome, '.hermes')
    const developerRoot = path.join(hermesRoot, 'profiles', 'developer')
    const writerRoot = path.join(hermesRoot, 'profiles', 'writer')
    fs.mkdirSync(developerRoot, { recursive: true })
    fs.mkdirSync(writerRoot, { recursive: true })
    fs.mkdirSync(path.join(hermesRoot, 'workspace'), { recursive: true })
    fs.writeFileSync(
      path.join(hermesRoot, 'config.yaml'),
      [
        'model:',
        '  default: Kimi-K2.7-Code',
        '  provider: tokenx',
        'providers:',
        '  tokenx:',
        '    base_url: https://model.example/v1',
        '    key_env: TOKENX_API_KEY_VPEL',
        'fallback_providers:',
        '  - provider: tokenx',
        '    model: GLM-5.2',
        '    base_url: https://model.example/v1',
        '    key_env: TOKENX_API_KEY_VPEL',
        'provider: tokenx',
        '',
      ].join('\n'),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(developerRoot, 'config.yaml'),
      [
        'model:',
        '  default: Kimi-K2.7-Code',
        '  provider: tokenx',
        'providers:',
        '  tokenx:',
        '    base_url: https://model.example/v1',
        '    key_env: TOKENX_API_KEY',
        'fallback_providers:',
        '  - provider: tokenx',
        '    model: GLM-4.7',
        '    base_url: https://model.example/v1',
        '    key_env: TOKENX_API_KEY',
        'provider: tokenx',
        '',
      ].join('\n'),
      'utf-8',
    )
    fs.writeFileSync(
      path.join(hermesRoot, '.env'),
      'TOKENX_API_KEY_VPEL=vpel-secret-value\nAPI_SERVER_PORT=8642\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(developerRoot, '.env'),
      'TOKENX_API_KEY=dev-secret-value\n',
      'utf-8',
    )
    fs.symlinkSync(path.join(hermesRoot, '.env'), path.join(writerRoot, '.env'))
    fs.writeFileSync(
      path.join(writerRoot, 'config.yaml'),
      'model: writer-model\nprovider: tokenx\n',
      'utf-8',
    )
  }

  it('discovers providers and models from the default profile only', () => {
    seedProfiles()
    const catalog = getProviderCatalog()
    const tokenx = catalog.providers.find((entry) => entry.id === 'tokenx')
    expect(tokenx?.base_url).toBe('https://model.example/v1')
    expect(tokenx?.models.sort()).toEqual(['GLM-5.2'])
  })

  it('discovers custom_providers key_env from yaml rows', () => {
    seedProfiles()
    fs.writeFileSync(
      path.join(tempHome, '.hermes', 'config.yaml'),
      [
        'providers:',
        '  tokenx:',
        '    base_url: https://model.example/v1',
        '    key_env: TOKENX_API_KEY_VPEL',
        'custom_providers:',
        '  - name: tokenx',
        '    base_url: https://model.example/v1',
        '    key_env: TOKENX_API_KEY_VPEL',
        '  - name: nvidia',
        '    base_url: https://integrate.api.nvidia.com/v1',
        '    key_env: NVIDIA_API_KEY',
        '',
      ].join('\n'),
      'utf-8',
    )
    const catalog = getProviderCatalog()
    expect(catalog.providers.map((entry) => entry.id).sort()).toEqual([
      'nvidia',
      'tokenx',
    ])
    expect(
      catalog.providers.find((entry) => entry.id === 'tokenx')?.key_env,
    ).toBe('TOKENX_API_KEY_VPEL')
    expect(
      catalog.providers.find((entry) => entry.id === 'nvidia')?.key_env,
    ).toBe('NVIDIA_API_KEY')
    expect(
      catalog.providers.find((entry) => entry.id === 'tokenx')?.keyConfigured,
    ).toBe(true)
  })

  it('writes a catalog key to every unique .env without duplicating symlinks', () => {
    seedProfiles()
    upsertCatalogKey('TOKENX_API_KEY', 'shared-tokenx')
    const rootEnv = fs.readFileSync(
      path.join(tempHome, '.hermes', '.env'),
      'utf-8',
    )
    const developerEnv = fs.readFileSync(
      path.join(tempHome, '.hermes', 'profiles', 'developer', '.env'),
      'utf-8',
    )
    expect(rootEnv).toContain('TOKENX_API_KEY=shared-tokenx')
    expect(developerEnv).toContain('TOKENX_API_KEY=shared-tokenx')
    expect(rootEnv).toContain('TOKENX_API_KEY_VPEL=vpel-secret-value')
  })

  it('saves builtin API keys to env only and does not seed providers.<id>', () => {
    seedProfiles()
    upsertCatalogKey('DEEPSEEK_API_KEY', 'ds-secret', 'deepseek')
    expect(readProfile('default').config.providers).not.toHaveProperty(
      'deepseek',
    )
    expect(readProfile('developer').config.providers).not.toHaveProperty(
      'deepseek',
    )
    const customProviders = readProfile('default').config.custom_providers
    expect(customProviders).toBeUndefined()
    const rootEnv = fs.readFileSync(
      path.join(tempHome, '.hermes', '.env'),
      'utf-8',
    )
    expect(rootEnv).toContain('DEEPSEEK_API_KEY=ds-secret')
    expect(
      getProviderCatalog().providers.find((entry) => entry.id === 'deepseek'),
    ).toMatchObject({
      key_env: 'DEEPSEEK_API_KEY',
      keyConfigured: true,
    })
  })

  it('removes custom providers entirely and clears unused keys', () => {
    seedProfiles()
    upsertCatalogProvider({
      id: 'nioint',
      name: 'nioint',
      base_url: 'https://modelgateway.nioint.com/v1',
      key_env: 'DEEPSEEK_API_KEY',
      key_value: 'ds-secret',
    })
    expect(
      getProviderCatalog().providers.some((entry) => entry.id === 'nioint'),
    ).toBe(true)

    removeCatalogProvider('nioint')

    expect(
      getProviderCatalog().providers.some((entry) => entry.id === 'nioint'),
    ).toBe(false)
    expect(readProfile('default').config.providers).not.toHaveProperty('nioint')
    expect(readProfile('developer').config.custom_providers || []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'nioint' })]),
    )
    const rootEnv = fs.readFileSync(
      path.join(tempHome, '.hermes', '.env'),
      'utf-8',
    )
    expect(rootEnv).not.toContain('DEEPSEEK_API_KEY=')
  })

  it('prunes redundant builtin provider blocks discovered from config', () => {
    seedProfiles()
    fs.writeFileSync(
      path.join(tempHome, '.hermes', 'config.yaml'),
      [
        'providers:',
        '  deepseek:',
        '    name: DeepSeek',
        '    base_url: https://api.deepseek.com/v1',
        '    key_env: DEEPSEEK_API_KEY',
        '    models:',
        '      - deepseek-v4-pro',
        '      - deepseek-v4-flash',
        '',
      ].join('\n'),
      'utf-8',
    )
    getProviderCatalog()
    expect(readProfile('default').config.providers).not.toHaveProperty(
      'deepseek',
    )
  })

  it('clears builtin provider keys but leaves the card identity', () => {
    seedProfiles()
    upsertCatalogKey('DEEPSEEK_API_KEY', 'ds-secret', 'deepseek')
    removeCatalogProvider('deepseek')
    expect(readProfile('default').config.providers).not.toHaveProperty(
      'deepseek',
    )
    expect(readProfile('developer').config.providers).not.toHaveProperty(
      'deepseek',
    )
    const rootEnv = fs.readFileSync(
      path.join(tempHome, '.hermes', '.env'),
      'utf-8',
    )
    expect(rootEnv).not.toContain('DEEPSEEK_API_KEY=')
    expect(isBuiltinCatalogProvider('deepseek')).toBe(true)
  })

  it('copies a provider URL into every profile without changing live fallbacks', () => {
    seedProfiles()
    // Use a NON-builtin id: builtins are (by design) pruned from profiles
    // instead of being redundantly written (syncProviderToAllProfiles).
    upsertCatalogProvider({
      id: 'tokenx',
      name: 'TokenX',
      base_url: 'https://model.example/v1',
      key_env: 'TOKENX_API_KEY',
    })
    expect(readProfile('default').config).toMatchObject({
      providers: { tokenx: { base_url: 'https://model.example/v1' } },
    })
    expect(readProfile('developer').config).toMatchObject({
      providers: { tokenx: { base_url: 'https://model.example/v1' } },
    })
    expect(readProfileProviderSelection('developer').fallbackModel).toBe(
      'GLM-4.7',
    )
  })

  it('writes and updates provider models on every profile', () => {
    seedProfiles()
    upsertCatalogProvider({
      id: 'tokenx',
      name: 'TokenX',
      base_url: 'https://model.example/v1',
      key_env: 'TOKENX_API_KEY',
      models: ['Kimi-K2.7-Code', 'GLM-4.7'],
    })
    expect(readProfile('default').config).toMatchObject({
      providers: {
        tokenx: {
          models: ['Kimi-K2.7-Code', 'GLM-4.7'],
        },
      },
    })

    upsertCatalogProvider({
      id: 'tokenx',
      models: ['Kimi-K2.7-Code'],
    })
    expect(readProfile('default').config).toMatchObject({
      providers: {
        tokenx: {
          models: ['Kimi-K2.7-Code'],
        },
      },
    })
  })

  it('writes the selected fallback into one profile only', () => {
    seedProfiles()
    updateProfileFallback('developer', 'tokenx', 'GLM-5.2')
    expect(readProfileProviderSelection('developer')).toMatchObject({
      fallbackProvider: 'tokenx',
      fallbackModel: 'GLM-5.2',
    })
    expect(readProfileProviderSelection('default').fallbackModel).toBe(
      'GLM-5.2',
    )
  })

  describe('getCatalogProviderCredential', () => {
    it('resolves the real base_url and API key for a configured provider', () => {
      seedProfiles()
      upsertCatalogKey('DEEPSEEK_API_KEY', 'ds-secret', 'deepseek')
      const credential = getCatalogProviderCredential('deepseek')
      expect(credential).toEqual({
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'ds-secret',
        keyEnv: 'DEEPSEEK_API_KEY',
      })
    })

    it('returns an empty API key when no key is configured', () => {
      seedProfiles()
      const credential = getCatalogProviderCredential('deepseek')
      expect(credential).toEqual({
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        keyEnv: 'DEEPSEEK_API_KEY',
      })
    })

    it('returns null for an unknown provider id', () => {
      seedProfiles()
      expect(getCatalogProviderCredential('does-not-exist')).toBeNull()
    })
  })

  describe('listCatalogProvidersForClaudeCode', () => {
    it('exposes every configured provider, not just Anthropic', () => {
      seedProfiles()
      upsertCatalogKey('ANTHROPIC_API_KEY', 'sk-ant-secret', 'anthropic')
      const listed = listCatalogProvidersForClaudeCode()
      const ids = listed.map((p) => p.id)
      expect(ids).toContain('anthropic')
      expect(ids).toContain('tokenx')
      const anthropicEntry = listed.find((p) => p.id === 'anthropic')
      expect(anthropicEntry).toMatchObject({
        keyConfigured: true,
        maskedKey: expect.stringContaining('sk-'),
      })
      // Never leaks the raw secret to this "safe for browser" projection.
      expect(JSON.stringify(listed)).not.toContain('sk-ant-secret')
    })
  })
})
