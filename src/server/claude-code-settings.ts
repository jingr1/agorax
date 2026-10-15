/**
 * Read ~/.claude/settings.json for Claude Code model configuration.
 * agents.yaml must not duplicate these — the CLI settings file is the source
 * of truth for both interactive `claude` and the hermes-workspace adapter.
 *
 * Reference: https://code.claude.com/docs/zh-CN/model-config
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { listCatalogProvidersForClaudeCode } from './provider-catalog'

export type ClaudeCodeSettings = {
  model?: string
  env?: Record<string, string | number | boolean>
  [key: string]: unknown
}

export type ClaudeCodeModelOption = {
  id: string
  name: string
  provider: string
  alias?: string
}

export function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

export function readClaudeCodeSettings(): ClaudeCodeSettings | null {
  try {
    const raw = fs.readFileSync(getClaudeSettingsPath(), 'utf-8')
    return JSON.parse(raw) as ClaudeCodeSettings
  } catch {
    return null
  }
}

export function writeClaudeCodeSettings(settings: ClaudeCodeSettings): void {
  const filePath = getClaudeSettingsPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

export type ClaudeCodeSettingsPatch = {
  model?: string
  env?: Record<string, string | number | boolean | null | undefined>
}

export function patchClaudeCodeSettings(
  patch: ClaudeCodeSettingsPatch,
): ClaudeCodeSettings {
  const current = readClaudeCodeSettings() ?? {}
  const next: ClaudeCodeSettings = { ...current }

  if (patch.model !== undefined) {
    next.model = patch.model
  }

  if (patch.env) {
    next.env = { ...(current.env ?? {}) }
    for (const [key, value] of Object.entries(patch.env)) {
      if (value === null) {
        delete next.env[key]
      } else if (value === undefined) {
        // Skip undefined keys: do not overwrite existing values.
      } else {
        next.env[key] = value
      }
    }
    if (Object.keys(next.env).length === 0) {
      delete next.env
    }
  }

  writeClaudeCodeSettings(next)
  return next
}

/** Env keys whose values are secrets and must never reach the browser. */
const SECRET_ENV_KEY_PATTERN = /API_KEY|AUTH_TOKEN|ACCESS_TOKEN|_SECRET/i

/** Return a settings object safe to serialize to the UI — secrets masked. */
export function maskClaudeCodeSettings(
  settings: ClaudeCodeSettings | null,
): ClaudeCodeSettings | null {
  if (!settings) return null
  const masked: ClaudeCodeSettings = {}
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'env' && value && typeof value === 'object') {
      masked.env = {}
      for (const [envKey, envValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (envValue === undefined || envValue === null) continue
        masked.env[envKey] =
          typeof envValue === 'string' &&
          envValue.length > 0 &&
          SECRET_ENV_KEY_PATTERN.test(envKey)
            ? '••••'
            : (envValue as string | number | boolean)
      }
      continue
    }
    masked[key] = value
  }
  return masked
}

export function settingsEnvRecord(
  settings: ClaudeCodeSettings | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = settings?.env
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    out[key] = String(value)
  }
  return out
}

/**
 * Derive a display provider from settings.env.ANTHROPIC_BASE_URL.
 * Prefer the Hermes provider catalog name when the base URL matches a
 * configured provider; fall back to the URL host; finally 'claude-code'.
 */
export function resolveClaudeCodeProvider(
  settings: ClaudeCodeSettings | null,
): string {
  const baseUrl = settingsEnvRecord(settings).ANTHROPIC_BASE_URL?.trim()
  if (!baseUrl) return 'claude-code'
  const normalizedBase = baseUrl.replace(/\/v1\/?$/, '')
  for (const entry of listCatalogProvidersForClaudeCode()) {
    const entryBase = entry.baseUrl.replace(/\/v1\/?$/, '')
    if (entryBase && entryBase === normalizedBase) {
      return entry.name || entry.id
    }
  }
  try {
    return new URL(baseUrl).host || 'claude-code'
  } catch {
    return 'claude-code'
  }
}

const ALIAS_KEYS: Array<{ alias: string; envKey: string }> = [
  { alias: 'haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
  { alias: 'sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { alias: 'opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
  { alias: 'fable', envKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL' },
]

/**
 * Expand Claude Code model aliases via ANTHROPIC_DEFAULT_* env vars.
 * Bare model ids (e.g. claude-opus-4-8) pass through unchanged.
 */
export function expandClaudeCodeModelAlias(
  model: string,
  settings: ClaudeCodeSettings | null = readClaudeCodeSettings(),
): string {
  const alias = model.trim()
  if (!alias) return ''
  const env = settingsEnvRecord(settings)
  const lower = alias.toLowerCase()
  for (const { alias: candidate, envKey } of ALIAS_KEYS) {
    if (lower === candidate && env[envKey]) {
      return env[envKey]
    }
  }
  return alias
}

/**
 * Resolve the currently selected model from settings.model, expanding aliases.
 */
export function resolveClaudeCodeCurrentModel(
  settings: ClaudeCodeSettings | null,
): string {
  if (!settings) return ''
  const alias =
    typeof settings.model === 'string' ? settings.model.trim() : ''
  if (!alias) return ''
  return expandClaudeCodeModelAlias(alias, settings)
}

/**
 * Models exposed in the Claude Code picker — sourced from settings.model and
 * settings.env defaults (haiku/sonnet/opus/fable). The subagent model is not
 * listed here because it is for workflow/subagent use, not the main chat
 * picker, and aliases like "haiku" can collide with the Claude Code aliases
 * we surface by name.
 */
export function listClaudeCodeModels(
  settings: ClaudeCodeSettings | null = readClaudeCodeSettings(),
): {
  models: Array<ClaudeCodeModelOption>
  currentModel: string
  currentProvider: string
} {
  const env = settingsEnvRecord(settings)
  const provider = resolveClaudeCodeProvider(settings)
  const seen = new Set<string>()
  const models: Array<ClaudeCodeModelOption> = []

  const push = (id: string | undefined, name?: string, alias?: string) => {
    const trimmed = id?.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    models.push({
      id: trimmed,
      name: name || trimmed,
      provider,
      ...(alias ? { alias } : {}),
    })
  }

  for (const { alias, envKey } of ALIAS_KEYS) {
    push(env[envKey], alias, alias)
  }

  const currentModel = resolveClaudeCodeCurrentModel(settings)
  // Ensure the currently selected model appears even if it isn't one of the
  // default-* slots (user may have set an arbitrary model id or alias).
  push(currentModel, settings?.model)

  return { models, currentModel, currentProvider: provider }
}
