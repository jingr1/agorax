import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  ensureCodexModelCatalog,
  listCodexModels,
  maskSecrets,
  patchCodexConfig,
  readCodexConfig,
  resolveCodexProviderName,
} from './codex-settings'

const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'hermes-codex-settings-test')
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'config.toml')
const TEST_CATALOG_DIR = path.join(TEST_CONFIG_DIR, 'model-catalogs')
const TEST_HERMES_HOME = path.join(TEST_CONFIG_DIR, 'hermes-home')

function resetTestConfig(text: string): void {
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(TEST_CONFIG_PATH, text, 'utf8')
}

function seedEndpointMetadata(models: Record<string, { context_length: number }>): void {
  const cacheDir = path.join(TEST_HERMES_HOME, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(
    path.join(cacheDir, 'endpoint_model_metadata.json'),
    JSON.stringify({
      'https://model.nioint.com/token-x/v1': {
        at: Date.now() / 1000,
        models: Object.fromEntries(
          Object.entries(models).map(([name, meta]) => [
            name,
            { name, context_length: meta.context_length },
          ]),
        ),
      },
    }),
    'utf8',
  )
}

const patchOpts = {
  catalogDir: TEST_CATALOG_DIR,
  hermesHome: TEST_HERMES_HOME,
}

describe('codex-settings', () => {
  beforeEach(() => {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  })
  afterEach(() => {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  })

  it('reads top-level model and provider', () => {
    resetTestConfig(`model = "gpt-5.6-terra"\nmodel_provider = "openai"\n`)
    const cfg = readCodexConfig(TEST_CONFIG_PATH)
    expect(cfg.model).toBe('gpt-5.6-terra')
    expect(cfg.provider).toBe('openai')
  })

  it('masks secrets recursively and preserves safe values', () => {
    const masked = maskSecrets({
      api_key: 'super-secret',
      token: 'another-secret',
      nested: { api_key: 'deep-secret' },
      safe: 'visible',
    })
    expect(masked.api_key).toBe('[REDACTED]')
    expect(masked.token).toBe('[REDACTED]')
    expect(masked.safe).toBe('visible')
  })

  it('patches top-level model and provider preserving other blocks', () => {
    resetTestConfig(`model = "old-model"\nmodel_provider = "old-provider"\n\n[mcp_servers.hermes-tools]\ncommand = "python3"\n`)

    patchCodexConfig(
      { model: 'gpt-5.6-terra', provider: 'openai' },
      TEST_CONFIG_PATH,
      patchOpts,
    )

    const text = fs.readFileSync(TEST_CONFIG_PATH, 'utf8')
    expect(text).toContain('model = "gpt-5.6-terra"')
    expect(text).toContain('model_provider = "openai"')
    expect(text).toContain('[mcp_servers.hermes-tools]')
    expect(text).toContain('command = "python3"')
  })

  it('writes env_key instead of hard-coded api_key when copying from catalog', () => {
    resetTestConfig(`model = "gpt-5.6-terra"\nmodel_provider = "openai"\n`)

    patchCodexConfig(
      { model: 'Kimi-K2.7-Code', copyFromCatalogProvider: 'tokenx' },
      TEST_CONFIG_PATH,
      patchOpts,
    )

    const text = fs.readFileSync(TEST_CONFIG_PATH, 'utf8')
    expect(text).toContain('model = "Kimi-K2.7-Code"')
    expect(text).toContain('model_provider = "tokenx"')
    expect(text).toContain('env_key = "TOKENX_API_KEY_VPEL"')
    expect(text).toContain('requires_openai_auth = false')
    expect(text).not.toContain('api_key')
  })

  it('overwrites an existing provider block in place', () => {
    resetTestConfig(`model = "old"
model_provider = "tokenx"

[model_providers.tokenx]
name = "Old Name"
base_url = "https://old.example/v1"
wire_api = "chat"
api_key = "old-key"
`)

    patchCodexConfig(
      { model: 'Kimi-K2.7-Code', copyFromCatalogProvider: 'tokenx' },
      TEST_CONFIG_PATH,
      patchOpts,
    )

    const text = fs.readFileSync(TEST_CONFIG_PATH, 'utf8')
    expect(text).toContain('model = "Kimi-K2.7-Code"')
    expect(text).toContain('wire_api = "responses"')
    expect(text).toContain('https://model.nioint.com/token-x/v1')
    expect(text).toContain('env_key = "TOKENX_API_KEY_VPEL"')
    expect(text).not.toContain('api_key = "old-key"')

    // Ensure no duplicate keys appear outside the table.
    const matches = text.match(/^env_key\s*=/gm) ?? []
    expect(matches.length).toBe(1)
    const reqMatches = text.match(/^requires_openai_auth\s*=/gm) ?? []
    expect(reqMatches.length).toBe(1)
  })

  it('switches back to openai and disables the previous catalog block key', () => {
    resetTestConfig(`model = "Kimi-K2.7-Code"
model_provider = "tokenx"
model_catalog_json = "${TEST_CATALOG_DIR}/tokenx.json"

[model_providers.tokenx]
name = "NIO TokenX"
base_url = "https://model.nioint.com/token-x/v1"
wire_api = "responses"
api_key = "real-key"
`)

    patchCodexConfig(
      { model: 'gpt-5.6-terra', provider: 'openai' },
      TEST_CONFIG_PATH,
      patchOpts,
    )

    const cfg = readCodexConfig(TEST_CONFIG_PATH)
    expect(cfg.model).toBe('gpt-5.6-terra')
    expect(cfg.provider).toBe('openai')

    const text = fs.readFileSync(TEST_CONFIG_PATH, 'utf8')
    expect(text).toContain('model_provider = "openai"')
    expect(text).toContain('# api_key = "real-key"')
    expect(text).toContain('[model_providers.tokenx]')
    expect(text).toContain('https://model.nioint.com/token-x/v1')
    expect(text).not.toContain('model_catalog_json')
  })

  it('writes model_catalog_json and catalog file when copying from catalog', () => {
    seedEndpointMetadata({
      'Kimi-K2.7-Code': { context_length: 256000 },
      'GPT-6.1-Terra': { context_length: 272000 },
    })
    resetTestConfig(`model = "gpt-5.6-terra"\nmodel_provider = "openai"\n`)

    patchCodexConfig(
      { model: 'GPT-6.1-Terra', copyFromCatalogProvider: 'tokenx' },
      TEST_CONFIG_PATH,
      patchOpts,
    )

    const text = fs.readFileSync(TEST_CONFIG_PATH, 'utf8')
    const catalogPath = path.join(TEST_CATALOG_DIR, 'tokenx.json')
    expect(text).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`)
    expect(fs.existsSync(catalogPath)).toBe(true)

    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      models: Array<{ slug: string; context_window: number; base_instructions: string }>
    }
    expect(catalog.models.some((m) => m.slug === 'GPT-6.1-Terra')).toBe(true)
    const terra = catalog.models.find((m) => m.slug === 'GPT-6.1-Terra')
    expect(terra?.context_window).toBe(272000)
    expect(terra?.base_instructions).toBeTruthy()
  })

  it('ensureCodexModelCatalog merges catalog models with endpoint metadata', () => {
    seedEndpointMetadata({
      'Kimi-K2.7-Code': { context_length: 256000 },
      'Only-In-Endpoint': { context_length: 99000 },
    })

    const result = ensureCodexModelCatalog('tokenx', {
      catalogDir: TEST_CATALOG_DIR,
      hermesHome: TEST_HERMES_HOME,
      extraModels: ['Extra-Selected'],
    })
    expect(result).not.toBeNull()
    expect(result?.catalogPath).toBe(path.join(TEST_CATALOG_DIR, 'tokenx.json'))

    const catalog = JSON.parse(fs.readFileSync(result!.catalogPath, 'utf8')) as {
      models: Array<{ slug: string; context_window: number }>
    }
    const bySlug = Object.fromEntries(catalog.models.map((m) => [m.slug, m]))
    expect(bySlug['Kimi-K2.7-Code']?.context_window).toBe(256000)
    expect(bySlug['Only-In-Endpoint']?.context_window).toBe(99000)
    expect(bySlug['Extra-Selected']?.context_window).toBe(128000)
  })

  it('resolves provider name from config block', () => {
    const name = resolveCodexProviderName(
      {
        model_providers: {
          tokenx: { name: 'NIO TokenX' },
        },
      },
      'tokenx',
    )
    expect(name).toBe('NIO TokenX')
  })

  it('falls back to provider id when block has no name', () => {
    expect(resolveCodexProviderName({ model_providers: {} }, 'openai')).toBe(
      'openai',
    )
  })

  it('lists catalog models when provider matches Hermes catalog', () => {
    resetTestConfig(`model = "Kimi-K2.7-Code"\nmodel_provider = "tokenx"\n`)
    const cfg = readCodexConfig(TEST_CONFIG_PATH)
    const models = listCodexModels({
      ...cfg,
      model: 'Kimi-K2.7-Code',
      provider: 'tokenx',
      providers: {
        tokenx: {
          name: 'NIO TokenX',
          base_url: 'https://model.nioint.com/token-x/v1',
          wire_api: 'responses',
        },
      },
    })
    expect(models.some((m) => m.id === 'Kimi-K2.7-Code')).toBe(true)
  })
})
