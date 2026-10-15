import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  getCatalogProviderCredential,
  listCatalogProvidersForClaudeCode,
  type CatalogProvider,
} from './provider-catalog'

export const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')

export function safeReadToml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {}
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    // Minimal TOML parser: top-level keys plus one level of nested tables.
    const result: Record<string, unknown> = {}
    let section: Array<string> = []
    for (const raw of text.split('\n')) {
      const line = raw.split('#')[0].trim()
      if (!line) continue
      if (line.startsWith('[')) {
        const inner = line.slice(1, line.indexOf(']') > 0 ? line.indexOf(']') : undefined).trim()
        section = inner.split('.').map((s) => s.trim())
        if (section.length === 1 && section[0]) {
          result[section[0]] = (result[section[0]] as Record<string, unknown> | undefined) || {}
        }
        continue
      }
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (section.length === 0) {
        result[key] = value
      } else if (section.length === 2) {
        const [parent, child] = section
        const parentObj = (result[parent] as Record<string, unknown> | undefined) || {}
        const childObj = (parentObj[child] as Record<string, unknown> | undefined) || {}
        childObj[key] = value
        parentObj[child] = childObj
        result[parent] = parentObj
      }
    }
    return result
  } catch {
    return {}
  }
}

export type CodexModelProviderBlock = {
  name?: string
  base_url?: string
  wire_api?: string
  api_key?: string
  env_key?: string
  requires_openai_auth?: boolean
  models?: Array<string>
}

export type CodexConfig = {
  model: string
  provider: string
  providerName: string
  providers: Record<string, CodexModelProviderBlock>
  raw: Record<string, unknown>
}

export function readCodexConfig(configPath = CODEX_CONFIG_PATH): CodexConfig {
  const config = safeReadToml(configPath)
  const model =
    typeof config.model === 'string'
      ? config.model
      : typeof config.selectedModel === 'string'
        ? config.selectedModel
        : ''
  const provider =
    typeof config.model_provider === 'string'
      ? config.model_provider
      : typeof config.provider === 'string'
        ? config.provider
        : ''
  const providers = (config.model_providers ?? {}) as Record<string, CodexModelProviderBlock>
  const providerName = provider
    ? resolveCodexProviderName({ model_providers: providers } as Record<string, unknown>, provider)
    : provider
  return { model, provider, providerName, providers, raw: config }
}

/** Mask likely secrets in a Codex config object before sending to the UI. */
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (lower === 'env_key' || lower === 'key_env') return false
  return (
    lower.includes('api_key') ||
    lower.includes('_key') ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password')
  )
}

function maskValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 0) {
    return '[REDACTED]'
  }
  if (Array.isArray(value)) {
    return value.map(maskValue)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return maskSecrets(value as Record<string, unknown>)
  }
  return value
}

export function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    result[key] = isSecretKey(key) ? maskValue(value) : value
  }
  return result
}


export type CodexConfigPatch = {
  model?: string
  provider?: string
  /** When set, copy a Hermes catalog provider's base_url/key into the block. */
  copyFromCatalogProvider?: string
}

/**
 * Build a provider block from the Hermes provider catalog.
 * Real key values are read server-side from .env and never leave the server.
 */
function buildCatalogProviderBlock(
  providerId: string,
): { id: string; name: string; block: CodexModelProviderBlock } | null {
  const providers = listCatalogProvidersForClaudeCode()
  const entry = providers.find((p) => p.id === providerId)
  if (!entry) return null
  const credential = getCatalogProviderCredential(providerId)
  const baseUrl = entry.baseUrl || credential?.baseUrl || ''
  const keyEnv = entry.keyEnv || credential?.keyEnv || ''
  // Codex 0.146+ expects base_url to end in /v1 because it appends
  // /responses (or /chat/completions) to it. The Hermes catalog already
  // stores OpenAI-compatible base URLs ending in /v1, so keep it.
  const normalizedBaseUrl = /\/v1\/?$/.test(baseUrl) ? baseUrl : baseUrl.replace(/\/?$/, '/v1')
  return {
    id: providerId,
    name: entry.name || providerId,
    block: {
      name: entry.name || providerId,
      base_url: normalizedBaseUrl,
      wire_api: 'responses',
      env_key: keyEnv,
      requires_openai_auth: false,
      api_key: '',
    },
  }
}

function parseTomlValue(raw: string): { type: 'string' | 'bool' | 'number' | 'inline-table'; value: string } {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return { type: 'inline-table', value: trimmed }
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return { type: 'bool', value: trimmed }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { type: 'number', value: trimmed }
  }
  // Treat everything else as a JSON-quoted string so TOML accepts it.
  return { type: 'string', value: JSON.stringify(trimmed) }
}

/**
 * Patch top-level model/model_provider and the [model_providers.<id>] block in
 * ~/.codex/config.toml. Rewrites only those keys; preserves everything else.
 *
 * When `copyFromCatalogProvider` is provided, the real base_url and api_key are
 * read from the Hermes provider catalog (Model & Provider page) and written
 * into the TOML block.
 */
function commentedKeyName(line: string): string | null {
  const withoutHash = line.replace(/^#\s*/, '')
  const eq = withoutHash.indexOf('=')
  if (eq < 0) return null
  return withoutHash.slice(0, eq).trim()
}

export function patchCodexConfig(
  patch: CodexConfigPatch,
  configPath = CODEX_CONFIG_PATH,
): void {
  const resolvedProvider = patch.copyFromCatalogProvider || patch.provider
  const catalog = resolvedProvider
    ? buildCatalogProviderBlock(resolvedProvider)
    : null

  let text = ''
  if (fs.existsSync(configPath)) {
    text = fs.readFileSync(configPath, 'utf8')
  }

  const lines = text.split('\n')
  const seen = new Set<string>()
  const updated: string[] = []
  let currentTable: string | null = null
  let currentTableHeaderIndex = -1

  const blockKeysToWrite = catalog
    ? [
        { key: 'name', value: catalog.block.name },
        { key: 'base_url', value: catalog.block.base_url },
        { key: 'wire_api', value: catalog.block.wire_api },
        { key: 'env_key', value: catalog.block.env_key },
        { key: 'requires_openai_auth', value: catalog.block.requires_openai_auth ?? false },
      ]
    : []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()

    // Preserve comments and blanks.
    if (!trimmed || trimmed.startsWith('#')) {
      updated.push(raw)
      continue
    }

    // Table header.
    if (trimmed.startsWith('[')) {
      // Before leaving a catalog provider block, inject any keys that were
      // missing from that block so they stay inside the table.
      if (catalog && currentTable === `model_providers.${catalog.id}`) {
        for (const { key, value } of blockKeysToWrite) {
          if (!seen.has(`mp.${catalog.id}.${key}`)) {
            updated.push(`${key} = ${JSON.stringify(value ?? '')}`)
            seen.add(`mp.${catalog.id}.${key}`)
          }
        }
      }

      // Flush any pending top-level keys before moving into a table.
      for (const key of ['model', 'model_provider']) {
        const patchValue =
          key === 'model' ? patch.model : catalog?.id ?? patch.provider
        if (patchValue !== undefined && !seen.has(key)) {
          updated.push(`${key} = ${JSON.stringify(patchValue)}`)
          seen.add(key)
        }
      }

      const inner = trimmed.slice(1, trimmed.indexOf(']') > 0 ? trimmed.indexOf(']') : undefined).trim()
      currentTable = inner
      currentTableHeaderIndex = updated.length
      updated.push(raw)
      continue
    }

    const eq = trimmed.indexOf('=')
    if (eq < 0) {
      updated.push(raw)
      continue
    }
    const key = trimmed.slice(0, eq).trim()

    // Top-level keys.
    if (currentTable === null) {
      if (key === 'model' && patch.model !== undefined) {
        updated.push(`model = ${JSON.stringify(patch.model)}`)
        seen.add('model')
      } else if (
        key === 'model_provider' &&
        (patch.provider !== undefined || catalog?.id !== undefined)
      ) {
        const providerValue = catalog?.id ?? patch.provider
        updated.push(`model_provider = ${JSON.stringify(providerValue)}`)
        seen.add('model_provider')
      } else {
        updated.push(raw)
      }
      continue
    }

    // When switching to a non-catalog provider (e.g. openai), neutralize any
    // stale [model_providers.<id>] block by removing its api_key so Codex does
    // not continue authenticating against the previous gateway.
    if (
      patch.provider !== undefined &&
      !patch.copyFromCatalogProvider &&
      currentTable.startsWith('model_providers.') &&
      currentTable !== `model_providers.${catalog?.id}`
    ) {
      if (key === 'api_key' || key === 'env_key') {
        updated.push(`# ${raw}  # disabled on switch to ${patch.provider}`)
        continue
      }
    }

    // [model_providers.<id>] block: overwrite or restore the target provider
    // block, leave other providers untouched. Commented-out managed keys are
    // restored so switching back from openai does not leave stale disabled
    // entries and duplicate active ones.
    if (currentTable === `model_providers.${catalog?.id}` && catalog) {
      seen.add(`__table__.model_providers.${catalog.id}`)
      const isCommented = trimmed.startsWith('#')
      const effectiveKey = isCommented ? commentedKeyName(raw) : key

      if (isCommented && effectiveKey === null) {
        updated.push(raw)
        continue
      }

      const managedKey = effectiveKey ?? key
      if (managedKey === 'name') {
        updated.push(`name = ${JSON.stringify(catalog.block.name)}`)
        seen.add(`mp.${catalog.id}.name`)
        continue
      } else if (managedKey === 'base_url') {
        updated.push(`base_url = ${JSON.stringify(catalog.block.base_url)}`)
        seen.add(`mp.${catalog.id}.base_url`)
        continue
      } else if (managedKey === 'wire_api') {
        updated.push(`wire_api = ${JSON.stringify(catalog.block.wire_api)}`)
        seen.add(`mp.${catalog.id}.wire_api`)
        continue
      } else if (managedKey === 'env_key') {
        updated.push(`env_key = ${JSON.stringify(catalog.block.env_key)}`)
        seen.add(`mp.${catalog.id}.env_key`)
        continue
      } else if (managedKey === 'requires_openai_auth') {
        updated.push(`requires_openai_auth = ${JSON.stringify(catalog.block.requires_openai_auth ?? false)}`)
        seen.add(`mp.${catalog.id}.requires_openai_auth`)
        continue
      } else if (managedKey === 'api_key') {
        // Drop hard-coded api_key so env_key is honored; real key stays in .env.
        updated.push(`# api_key removed; using env_key ${catalog.block.env_key}`)
        seen.add(`mp.${catalog.id}.api_key`)
        continue
      }

      updated.push(raw)
      continue
    }

    updated.push(raw)
  }

  // Flush top-level keys if they were not present before the first table.
  for (const key of ['model', 'model_provider']) {
    const patchValue =
      key === 'model' ? patch.model : catalog?.id ?? patch.provider
    if (patchValue !== undefined && !seen.has(key)) {
      updated.push(`${key} = ${JSON.stringify(patchValue)}`)
      seen.add(key)
    }
  }

  if (catalog) {
    // If the block already existed, make sure every managed key is present
    // inside that table. We insert them right after the table header so they
    // stay inside the block.
    const tableMarker = `[model_providers.${catalog.id}]`
    const headerIdx = updated.indexOf(tableMarker)
    if (headerIdx >= 0) {
      const insertions: string[] = []
      for (const { key, value } of blockKeysToWrite) {
        if (!seen.has(`mp.${catalog.id}.${key}`)) {
          insertions.push(`${key} = ${JSON.stringify(value ?? '')}`)
          seen.add(`mp.${catalog.id}.${key}`)
        }
      }
      if (insertions.length) {
        updated.splice(headerIdx + 1, 0, ...insertions)
      }
    } else {
      // The block did not exist at all: append it.
      updated.push(`[model_providers.${catalog.id}]`)
      for (const { key, value } of blockKeysToWrite) {
        updated.push(`${key} = ${JSON.stringify(value ?? '')}`)
      }
    }
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, updated.join('\n') + (updated.length > 0 ? '\n' : ''), 'utf8')
}

export function resolveCodexProviderName(
  config: Record<string, unknown>,
  providerId: string,
): string {
  const providers = config.model_providers as
    | Record<string, Record<string, unknown>>
    | undefined
  const block = providers?.[providerId]
  if (!block) return providerId
  return typeof block.name === 'string' && block.name.trim()
    ? block.name.trim()
    : providerId
}

/**
 * Resolve the display provider for a Codex configuration.
 * Prefer the Hermes provider catalog name when the configured provider id
 * matches a catalog entry; fall back to the block name in config.toml; finally
 * the raw provider id.
 */
export function resolveCodexProviderDisplay(
  config: CodexConfig,
): string {
  if (!config.provider) return ''
  const catalog = listCatalogProvidersForClaudeCode().find(
    (p) => p.id === config.provider,
  )
  if (catalog) return catalog.name
  return config.providerName || config.provider
}

/**
 * Models exposed in the Codex chat picker.
 * When the current provider came from the Hermes catalog, use that catalog's
 * model list. Otherwise fall back to models declared under
 * [model_providers.<id>] in config.toml.
 */
export function listCodexModels(
  config: CodexConfig,
): { id: string; name: string; provider: string }[] {
  const providerId = config.provider
  const providerName = resolveCodexProviderDisplay(config)

  const catalog = providerId
    ? listCatalogProvidersForClaudeCode().find((p) => p.id === providerId)
    : undefined

  if (catalog && catalog.models.length > 0) {
    return catalog.models.map((id) => ({ id, name: id, provider: providerName }))
  }

  const seen = new Set<string>()
  if (config.model) seen.add(config.model)
  const block = providerId ? config.providers[providerId] : undefined
  if (block && Array.isArray(block.models)) {
    for (const m of block.models) {
      if (typeof m === 'string') seen.add(m)
    }
  }

  return Array.from(seen)
    .filter(Boolean)
    .map((id) => ({ id, name: id, provider: providerName }))
}
