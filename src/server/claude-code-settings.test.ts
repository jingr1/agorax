import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: Array<string> = []

function createTempClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'))
  const claudeDir = path.join(dir, '.claude')
  fs.mkdirSync(claudeDir)
  tempDirs.push(dir)
  return claudeDir
}

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal())
  return {
    ...actual,
    homedir: vi.fn(() => {
      // Tests that need a homedir create a temp dir and set TEST_HERMES_HOME.
      const override = process.env.TEST_HERMES_HOME
      if (override) return override
      return actual.homedir()
    }),
  }
})

async function importModule() {
  vi.resetModules()
  return import('./claude-code-settings')
}

beforeEach(() => {
  delete process.env.TEST_HERMES_HOME
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('claude-code-settings', () => {
  describe('readClaudeCodeSettings', () => {
    it('parses valid settings.json', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({ model: 'claude-sonnet-4-6' }),
      )
      const { readClaudeCodeSettings } = await importModule()
      const settings = readClaudeCodeSettings()
      expect(settings).toEqual({ model: 'claude-sonnet-4-6' })
    })

    it('returns null when file is missing', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.rmSync(claudeDir, { recursive: true, force: true })
      const { readClaudeCodeSettings } = await importModule()
      expect(readClaudeCodeSettings()).toBeNull()
    })
  })

  describe('writeClaudeCodeSettings', () => {
    it('creates the .claude directory if missing and writes formatted JSON', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.rmSync(claudeDir, { recursive: true, force: true })
      const { writeClaudeCodeSettings } = await importModule()
      writeClaudeCodeSettings({ model: 'claude-haiku-3-5' })
      const written = fs.readFileSync(
        path.join(claudeDir, 'settings.json'),
        'utf-8',
      )
      expect(written).toBe(
        `${JSON.stringify({ model: 'claude-haiku-3-5' }, null, 2)}\n`,
      )
    })
  })

  describe('patchClaudeCodeSettings', () => {
    it('merges model and env updates', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          model: 'old-model',
          env: { ANTHROPIC_API_KEY: 'secret' },
        }),
      )
      const { patchClaudeCodeSettings } = await importModule()
      const result = patchClaudeCodeSettings({
        model: 'new-model',
        env: { ANTHROPIC_BASE_URL: 'https://example.com' },
      })
      expect(result.model).toBe('new-model')
      expect(result.env).toEqual({
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://example.com',
      })
    })

    it('merges env updates and removes null env entries', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_API_KEY: 'secret',
            ANTHROPIC_BASE_URL: 'https://example.com',
          },
        }),
      )
      const { patchClaudeCodeSettings } = await importModule()
      const result = patchClaudeCodeSettings({
        env: {
          ANTHROPIC_API_KEY: 'new-secret',
          ANTHROPIC_BASE_URL: null,
        },
      })
      expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'new-secret' })
    })

    it('removes empty env object', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({ env: { X: 'y' } }),
      )
      const { patchClaudeCodeSettings } = await importModule()
      const result = patchClaudeCodeSettings({ env: { X: null } })
      expect(result.env).toBeUndefined()
    })

    it('does not write a provider field', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({}))
      const { patchClaudeCodeSettings } = await importModule()
      const result = patchClaudeCodeSettings({ model: 'opus' })
      expect(result.provider).toBeUndefined()
      expect(result.modelProvider).toBeUndefined()
    })
  })

  describe('maskClaudeCodeSettings', () => {
    it('masks secret env values but keeps non-secret fields like base URL', async () => {
      const { maskClaudeCodeSettings } = await importModule()
      const masked = maskClaudeCodeSettings({
        model: 'claude-sonnet-4-6',
        env: {
          ANTHROPIC_API_KEY: 'super-secret',
          ANTHROPIC_AUTH_TOKEN: 'gateway-secret',
          ANTHROPIC_BASE_URL: 'https://example.com',
          EMPTY: '',
        },
      })
      expect(masked).toEqual({
        model: 'claude-sonnet-4-6',
        env: {
          ANTHROPIC_API_KEY: '••••',
          ANTHROPIC_AUTH_TOKEN: '••••',
          ANTHROPIC_BASE_URL: 'https://example.com',
          EMPTY: '',
        },
      })
    })

    it('returns null for null input', async () => {
      const { maskClaudeCodeSettings } = await importModule()
      expect(maskClaudeCodeSettings(null)).toBeNull()
    })
  })

  describe('expandClaudeCodeModelAlias', () => {
    it('expands haiku, sonnet, opus, and fable aliases', async () => {
      const { expandClaudeCodeModelAlias } = await importModule()
      const settings = {
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
          ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
        },
      }
      expect(expandClaudeCodeModelAlias('haiku', settings)).toBe(
        'claude-haiku-4-5',
      )
      expect(expandClaudeCodeModelAlias('sonnet', settings)).toBe(
        'claude-sonnet-4-6',
      )
      expect(expandClaudeCodeModelAlias('opus', settings)).toBe(
        'claude-opus-4-8',
      )
      expect(expandClaudeCodeModelAlias('fable', settings)).toBe(
        'claude-fable-5',
      )
    })

    it('passes through bare model ids', async () => {
      const { expandClaudeCodeModelAlias } = await importModule()
      expect(expandClaudeCodeModelAlias('claude-opus-4-8', null)).toBe(
        'claude-opus-4-8',
      )
    })
  })

  describe('listClaudeCodeModels', () => {
    it('lists default env slots and current model without duplicates', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          model: 'opus',
          env: {
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-3-5',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
            CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
          },
        }),
      )
      const { listClaudeCodeModels, readClaudeCodeSettings } =
        await importModule()
      const result = listClaudeCodeModels(readClaudeCodeSettings())
      expect(result.currentModel).toBe('claude-opus-4-8')
      expect(result.currentProvider).toBe('claude-code')
      expect(result.models.map((m) => m.id)).toEqual([
        'claude-haiku-3-5',
        'claude-sonnet-4-6',
        'claude-opus-4-8',
        'claude-fable-5',
      ])
    })

    it('falls back to provider from ANTHROPIC_BASE_URL', async () => {
      const claudeDir = createTempClaudeDir()
      process.env.TEST_HERMES_HOME = path.dirname(claudeDir)
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({
          model: 'custom-model',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
          },
        }),
      )
      const { listClaudeCodeModels, readClaudeCodeSettings } =
        await importModule()
      const result = listClaudeCodeModels(readClaudeCodeSettings())
      expect(result.currentProvider).toBe('api.example.com')
      expect(result.models.some((m) => m.id === 'custom-model')).toBe(true)
    })
  })
})
