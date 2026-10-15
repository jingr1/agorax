import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  listCodexModels,
  maskSecrets,
  patchCodexConfig,
  readCodexConfig,
  resolveCodexProviderName,
} from './codex-settings'

const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'hermes-codex-settings-test')
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'config.toml')

function resetTestConfig(text: string): void {
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(TEST_CONFIG_PATH, text, 'utf8')
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

[model_providers.tokenx]
name = "NIO TokenX"
base_url = "https://model.nioint.com/token-x/v1"
wire_api = "responses"
api_key = "real-key"
`)

    patchCodexConfig(
      { model: 'gpt-5.6-terra', provider: 'openai' },
      TEST_CONFIG_PATH,
    )

    const cfg = readCodexConfig(TEST_CONFIG_PATH)
    expect(cfg.model).toBe('gpt-5.6-terra')
    expect(cfg.provider).toBe('openai')

    const text = fs.readFileSync(TEST_CONFIG_PATH, 'utf8')
    expect(text).toContain('model_provider = "openai"')
    expect(text).toContain('# api_key = "real-key"')
    expect(text).toContain('[model_providers.tokenx]')
    expect(text).toContain('https://model.nioint.com/token-x/v1')
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
