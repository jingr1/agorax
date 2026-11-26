import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  getCatalogProviderCredential,
  listCatalogProvidersForClaudeCode,
} from './provider-catalog'

export function resolveCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.codex')
}

export const CODEX_CONFIG_PATH = path.join(resolveCodexHome(), 'config.toml')

/** Default context window when Hermes endpoint metadata has no entry. */
const DEFAULT_CONTEXT_WINDOW = 128_000

const DEFAULT_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  {
    effort: 'medium',
    description: 'Balances speed and reasoning depth for everyday tasks',
  },
  {
    effort: 'high',
    description: 'Greater reasoning depth for complex problems',
  },
  {
    effort: 'xhigh',
    description: 'Extra high reasoning depth for complex problems',
  },
  {
    effort: 'max',
    description: 'Maximum reasoning depth for the hardest problems',
  },
] as const

/** Short identity prompt — Codex requires base_instructions on catalog entries. */
const DEFAULT_BASE_INSTRUCTIONS =
  'You are Codex, a coding agent. Collaborate with the user until their goal is handled.'

export type EnsureCodexModelCatalogOptions = {
  /** Override ~/.codex/model-catalogs (tests). */
  catalogDir?: string
  /** Override HERMES_HOME root used for endpoint metadata (tests). */
  hermesHome?: string
  /** Extra model ids to include (e.g. the model being selected now). */
  extraModels?: string[]
}

export type CodexModelCatalogResult = {
  providerId: string
  catalogPath: string
  modelCount: number
}

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
  /**
   * Rebuild ~/.codex/model-catalogs/<provider>.json for the current catalog
   * provider and refresh model_catalog_json. Ignored for official openai.
   */
  rebuildModelCatalog?: boolean
}

export type PatchCodexConfigOptions = {
  /** Override model-catalogs directory (tests). */
  catalogDir?: string
  /** Override HERMES_HOME for endpoint metadata (tests). */
  hermesHome?: string
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

function resolveHermesHome(explicit?: string): string {
  if (explicit?.trim()) return path.resolve(explicit.trim())
  const fromEnv = process.env.HERMES_HOME?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.hermes')
}

function normalizeEndpointUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

function endpointUrlCandidates(baseUrl: string): string[] {
  const normalized = normalizeEndpointUrl(baseUrl)
  if (!normalized) return []
  const withoutV1 = normalized.replace(/\/v1$/, '')
  const withV1 = /\/v1$/.test(normalized) ? normalized : `${normalized}/v1`
  return Array.from(new Set([normalized, withoutV1, withV1].filter(Boolean)))
}

type EndpointModelMeta = {
  name?: string
  context_length?: number
}

/**
 * Hermes caches per-endpoint model context windows at
 * `$HERMES_HOME/cache/endpoint_model_metadata.json`.
 */
export function readEndpointModelMetadata(
  hermesHome = resolveHermesHome(),
): Record<string, Record<string, EndpointModelMeta>> {
  const filePath = path.join(hermesHome, 'cache', 'endpoint_model_metadata.json')
  if (!fs.existsSync(filePath)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      { models?: Record<string, EndpointModelMeta> }
    >
    const out: Record<string, Record<string, EndpointModelMeta>> = {}
    for (const [url, entry] of Object.entries(raw)) {
      if (entry?.models && typeof entry.models === 'object') {
        out[normalizeEndpointUrl(url)] = entry.models
      }
    }
    return out
  } catch {
    return {}
  }
}

function resolveEndpointModelsForBaseUrl(
  baseUrl: string,
  hermesHome?: string,
): Record<string, EndpointModelMeta> {
  const byUrl = readEndpointModelMetadata(hermesHome)
  for (const candidate of endpointUrlCandidates(baseUrl)) {
    const hit = byUrl[candidate]
    if (hit) return hit
  }
  return {}
}

function safeCatalogFileName(providerId: string): string {
  const cleaned = providerId.trim().replace(/[^a-zA-Z0-9._-]+/g, '_')
  return cleaned || 'provider'
}

export function resolveCodexModelCatalogPath(
  providerId: string,
  catalogDir?: string,
): string {
  const dir =
    catalogDir?.trim() ||
    path.join(resolveCodexHome(), 'model-catalogs')
  return path.join(dir, `${safeCatalogFileName(providerId)}.json`)
}

function buildCodexCatalogModelEntry(input: {
  slug: string
  providerName: string
  contextWindow: number
  priority: number
}): Record<string, unknown> {
  const { slug, providerName, contextWindow, priority } = input
  return {
    slug,
    display_name: slug,
    description: `${providerName} · ${slug}`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS.map((level) => ({
      ...level,
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    base_instructions: DEFAULT_BASE_INSTRUCTIONS,
    support_verbosity: true,
    default_verbosity: 'medium',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    experimental_supported_tools: [],
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    input_modalities: ['text'],
  }
}

/**
 * Materialize `~/.codex/model-catalogs/<providerId>.json` in Codex
 * ModelsResponse shape from the Hermes provider catalog + endpoint metadata.
 *
 * Returns null when the provider id is not in the Hermes catalog.
 */
export function ensureCodexModelCatalog(
  providerId: string,
  options: EnsureCodexModelCatalogOptions = {},
): CodexModelCatalogResult | null {
  const id = providerId.trim()
  if (!id) return null

  const providers = listCatalogProvidersForClaudeCode()
  const entry = providers.find((p) => p.id === id)
  if (!entry) return null

  const credential = getCatalogProviderCredential(id)
  const baseUrl = entry.baseUrl || credential?.baseUrl || ''
  const endpointModels = resolveEndpointModelsForBaseUrl(
    baseUrl,
    options.hermesHome,
  )

  const modelIds = new Set<string>()
  for (const model of entry.models) {
    if (typeof model === 'string' && model.trim()) modelIds.add(model.trim())
  }
  for (const model of Object.keys(endpointModels)) {
    if (model.trim()) modelIds.add(model.trim())
  }
  for (const model of options.extraModels ?? []) {
    if (typeof model === 'string' && model.trim()) modelIds.add(model.trim())
  }

  const providerName = entry.name || id
  const models = Array.from(modelIds).map((slug, index) => {
    const meta = endpointModels[slug]
    const contextWindow =
      typeof meta?.context_length === 'number' && meta.context_length > 0
        ? meta.context_length
        : DEFAULT_CONTEXT_WINDOW
    return buildCodexCatalogModelEntry({
      slug,
      providerName,
      contextWindow,
      priority: index + 1,
    })
  })

  const catalogPath = resolveCodexModelCatalogPath(id, options.catalogDir)
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true })
  fs.writeFileSync(
    catalogPath,
    `${JSON.stringify({ models }, null, 2)}\n`,
    'utf8',
  )

  return { providerId: id, catalogPath, modelCount: models.length }
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
 * Patch top-level model/model_provider/model_catalog_json and the
 * [model_providers.<id>] block in ~/.codex/config.toml. Rewrites only those
 * keys; preserves everything else.
 *
 * When `copyFromCatalogProvider` is provided, the real base_url and api_key are
 * read from the Hermes provider catalog (Model & Provider page) and written
 * into the TOML block. Custom providers also get a ModelsResponse catalog at
 * ~/.codex/model-catalogs/<id>.json wired via model_catalog_json. Official
 * OpenAI/ChatGPT paths clear that pointer so the built-in catalog stays in use.
 */
function commentedKeyName(line: string): string | null {
  const withoutHash = line.replace(/^#\s*/, '')
  const eq = withoutHash.indexOf('=')
  if (eq < 0) return null
  return withoutHash.slice(0, eq).trim()
}

/** `# env_key = "…"  # disabled on switch to openai` (may be nested `# # …`). */
function isDisabledSwitchAuthLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('#')) return false
  if (!/\bdisabled on switch to\b/.test(trimmed)) return false
  const key = commentedKeyName(trimmed.replace(/^#\s*/, ''))
  return key === 'api_key' || key === 'env_key'
}

function disabledSwitchAuthKey(line: string): 'api_key' | 'env_key' | null {
  if (!isDisabledSwitchAuthLine(line)) return null
  const key = commentedKeyName(line.trim().replace(/^#\s*/, ''))
  return key === 'api_key' || key === 'env_key' ? key : null
}

/** Strip leading `#` wrappers and trailing `disabled on switch` markers. */
function unwrapDisabledSwitchAssignment(line: string): string {
  let text = line.trim()
  while (text.startsWith('#')) {
    text = text.replace(/^#\s*/, '')
  }
  return text.replace(/\s*#\s*disabled on switch to\b.*$/i, '').trim()
}

function flushTopLevelKeys(
  updated: string[],
  seen: Set<string>,
  values: Record<string, string | undefined>,
  clearKeys: Set<string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || seen.has(key)) continue
    updated.push(`${key} = ${JSON.stringify(value)}`)
    seen.add(key)
  }
  for (const key of clearKeys) {
    seen.add(key)
  }
}

export function patchCodexConfig(
  patch: CodexConfigPatch,
  configPath = CODEX_CONFIG_PATH,
  options: PatchCodexConfigOptions = {},
): void {
  // Prefer copyFromCatalogProvider for the provider block; bare provider
  // (openai) only updates model_provider and clears custom catalog pointer.
  const catalogForBlock = patch.copyFromCatalogProvider
    ? buildCatalogProviderBlock(patch.copyFromCatalogProvider)
    : null

  const clearModelCatalogJson =
    Boolean(patch.provider) && !patch.copyFromCatalogProvider

  let modelCatalogJsonPath: string | undefined
  const catalogEnsureId =
    catalogForBlock?.id ||
    (patch.rebuildModelCatalog && !clearModelCatalogJson
      ? patch.copyFromCatalogProvider || patch.provider
      : undefined)
  if (catalogEnsureId) {
    const ensured = ensureCodexModelCatalog(catalogEnsureId, {
      catalogDir: options.catalogDir,
      hermesHome: options.hermesHome,
      extraModels: patch.model ? [patch.model] : undefined,
    })
    if (ensured) modelCatalogJsonPath = ensured.catalogPath
  }

  let text = ''
  if (fs.existsSync(configPath)) {
    text = fs.readFileSync(configPath, 'utf8')
  }

  const lines = text.split('\n')
  const seen = new Set<string>()
  const updated: string[] = []
  let currentTable: string | null = null

  const topLevelValues: Record<string, string | undefined> = {
    model: patch.model,
    model_provider: catalogForBlock?.id ?? patch.provider,
    model_catalog_json: clearModelCatalogJson
      ? undefined
      : modelCatalogJsonPath,
  }
  const clearTopLevelKeys = new Set<string>()
  if (clearModelCatalogJson) clearTopLevelKeys.add('model_catalog_json')

  const blockKeysToWrite = catalogForBlock
    ? [
        { key: 'name', value: catalogForBlock.block.name },
        { key: 'base_url', value: catalogForBlock.block.base_url },
        { key: 'wire_api', value: catalogForBlock.block.wire_api },
        { key: 'env_key', value: catalogForBlock.block.env_key },
        {
          key: 'requires_openai_auth',
          value: catalogForBlock.block.requires_openai_auth ?? false,
        },
      ]
    : []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()

    // Preserve blanks.
    if (!trimmed) {
      updated.push(raw)
      continue
    }

    // Preserve ordinary comments. Managed "disabled on switch" auth lines are
    // handled below so openai↔catalog switches do not accumulate duplicates.
    if (trimmed.startsWith('#') && !isDisabledSwitchAuthLine(trimmed)) {
      updated.push(raw)
      continue
    }

    if (trimmed.startsWith('#') && isDisabledSwitchAuthLine(trimmed)) {
      const disabledKey = disabledSwitchAuthKey(trimmed)
      if (
        disabledKey &&
        currentTable?.startsWith('model_providers.') &&
        patch.provider !== undefined &&
        !patch.copyFromCatalogProvider &&
        currentTable !== `model_providers.${catalogForBlock?.id}`
      ) {
        // Staying on / switching to a non-catalog provider: keep one marker.
        const seenKey = `${currentTable}.${disabledKey}.disabled`
        if (!seen.has(seenKey)) {
          const assignment = unwrapDisabledSwitchAssignment(trimmed)
          updated.push(
            `# ${assignment}  # disabled on switch to ${patch.provider}`,
          )
          seen.add(seenKey)
        }
        continue
      }
      if (
        disabledKey &&
        catalogForBlock &&
        currentTable === `model_providers.${catalogForBlock.id}`
      ) {
        // Switching back to this catalog provider: drop disabled markers;
        // the managed-key path / block injection writes the active key once.
        continue
      }
      // Outside a relevant provider table — keep as a normal comment.
      updated.push(raw)
      continue
    }

    // Table header.
    if (trimmed.startsWith('[')) {
      // Before leaving a catalog provider block, inject any keys that were
      // missing from that block so they stay inside the table.
      if (
        catalogForBlock &&
        currentTable === `model_providers.${catalogForBlock.id}`
      ) {
        for (const { key, value } of blockKeysToWrite) {
          if (!seen.has(`mp.${catalogForBlock.id}.${key}`)) {
            updated.push(`${key} = ${JSON.stringify(value ?? '')}`)
            seen.add(`mp.${catalogForBlock.id}.${key}`)
          }
        }
      }

      flushTopLevelKeys(updated, seen, topLevelValues, clearTopLevelKeys)

      const inner = trimmed
        .slice(1, trimmed.indexOf(']') > 0 ? trimmed.indexOf(']') : undefined)
        .trim()
      currentTable = inner
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
        (patch.provider !== undefined || catalogForBlock?.id !== undefined)
      ) {
        const providerValue = catalogForBlock?.id ?? patch.provider
        updated.push(`model_provider = ${JSON.stringify(providerValue)}`)
        seen.add('model_provider')
      } else if (key === 'model_catalog_json') {
        if (clearModelCatalogJson) {
          // Drop the pointer so Codex uses its official built-in catalog.
          seen.add('model_catalog_json')
        } else if (modelCatalogJsonPath !== undefined) {
          updated.push(
            `model_catalog_json = ${JSON.stringify(modelCatalogJsonPath)}`,
          )
          seen.add('model_catalog_json')
        } else {
          updated.push(raw)
        }
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
      currentTable !== `model_providers.${catalogForBlock?.id}`
    ) {
      if (key === 'api_key' || key === 'env_key') {
        const seenKey = `${currentTable}.${key}.disabled`
        if (!seen.has(seenKey)) {
          updated.push(`# ${raw}  # disabled on switch to ${patch.provider}`)
          seen.add(seenKey)
        }
        continue
      }
    }

    // [model_providers.<id>] block: overwrite the target provider block, leave
    // other providers untouched. Disabled-switch comments for this block were
    // dropped above so we do not restore them as duplicate active keys.
    if (
      currentTable === `model_providers.${catalogForBlock?.id}` &&
      catalogForBlock
    ) {
      seen.add(`__table__.model_providers.${catalogForBlock.id}`)
      const managedKey = key
      const seenManaged = `mp.${catalogForBlock.id}.${managedKey}`
      if (managedKey === 'name') {
        if (!seen.has(seenManaged)) {
          updated.push(`name = ${JSON.stringify(catalogForBlock.block.name)}`)
          seen.add(seenManaged)
        }
        continue
      } else if (managedKey === 'base_url') {
        if (!seen.has(seenManaged)) {
          updated.push(
            `base_url = ${JSON.stringify(catalogForBlock.block.base_url)}`,
          )
          seen.add(seenManaged)
        }
        continue
      } else if (managedKey === 'wire_api') {
        if (!seen.has(seenManaged)) {
          updated.push(
            `wire_api = ${JSON.stringify(catalogForBlock.block.wire_api)}`,
          )
          seen.add(seenManaged)
        }
        continue
      } else if (managedKey === 'env_key') {
        if (!seen.has(seenManaged)) {
          updated.push(
            `env_key = ${JSON.stringify(catalogForBlock.block.env_key)}`,
          )
          seen.add(seenManaged)
        }
        continue
      } else if (managedKey === 'requires_openai_auth') {
        if (!seen.has(seenManaged)) {
          updated.push(
            `requires_openai_auth = ${JSON.stringify(catalogForBlock.block.requires_openai_auth ?? false)}`,
          )
          seen.add(seenManaged)
        }
        continue
      } else if (managedKey === 'api_key') {
        // Drop hard-coded api_key so env_key is honored; real key stays in .env.
        if (!seen.has(seenManaged)) {
          updated.push(
            `# api_key removed; using env_key ${catalogForBlock.block.env_key}`,
          )
          seen.add(seenManaged)
        }
        continue
      }

      updated.push(raw)
      continue
    }

    updated.push(raw)
  }

  // Flush top-level keys if they were not present before the first table.
  flushTopLevelKeys(updated, seen, topLevelValues, clearTopLevelKeys)

  if (catalogForBlock) {
    // If the block already existed, make sure every managed key is present
    // inside that table. We insert them right after the table header so they
    // stay inside the block.
    const tableMarker = `[model_providers.${catalogForBlock.id}]`
    const headerIdx = updated.indexOf(tableMarker)
    if (headerIdx >= 0) {
      const insertions: string[] = []
      for (const { key, value } of blockKeysToWrite) {
        if (!seen.has(`mp.${catalogForBlock.id}.${key}`)) {
          insertions.push(`${key} = ${JSON.stringify(value ?? '')}`)
          seen.add(`mp.${catalogForBlock.id}.${key}`)
        }
      }
      if (insertions.length) {
        updated.splice(headerIdx + 1, 0, ...insertions)
      }
    } else {
      // The block did not exist at all: append it.
      updated.push(`[model_providers.${catalogForBlock.id}]`)
      for (const { key, value } of blockKeysToWrite) {
        updated.push(`${key} = ${JSON.stringify(value ?? '')}`)
      }
    }
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(
    configPath,
    updated.join('\n') + (updated.length > 0 ? '\n' : ''),
    'utf8',
  )
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
