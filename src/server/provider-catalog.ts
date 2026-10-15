import fs from 'node:fs'
import path from 'node:path'

import {
  listProfiles,
  readProfile,
  resolveProfileHermesHome,
  updateProfileConfig,
} from './profiles-browser'
import { parseEnvFile, stringifyEnv } from './hermes-config-store'
import { getStateDir } from './workspace-state-dir'

export type CatalogProvider = {
  id: string
  name: string
  base_url: string
  key_env: string
  models: Array<string>
  keyConfigured: boolean
  maskedKey: string
}

export type ProviderCatalog = {
  providers: Array<CatalogProvider>
}

export type ProfileProviderSelection = {
  provider: string
  model: string
  fallbackProvider: string
  fallbackModel: string
}

type CatalogFile = {
  providers: Array<{
    id: string
    name?: string
    base_url?: string
    key_env?: string
    models?: Array<string>
  }>
}

/**
 * Hermes built-in API-key providers — catalog/UI metadata only.
 *
 * These providers are registered in hermes-agent (PROVIDER_REGISTRY + provider
 * plugins). Workspace must NOT write them into config.yaml ``providers:`` —
 * only ``.env`` keys and ``model.provider`` selection are needed at runtime.
 *
 * See docs/design/provider-catalog.md.
 */
export const BUILTIN_PROVIDER_PRESETS: Record<
  string,
  { name: string; base_url: string; key_env: string; models: Array<string> }
> = {
  anthropic: {
    name: 'Anthropic',
    base_url: '',
    key_env: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-3-5'],
  },
  deepseek: {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    key_env: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  openrouter: {
    name: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    key_env: 'OPENROUTER_API_KEY',
    models: ['auto', 'deepseek/deepseek-r1', 'google/gemini-2.5-pro'],
  },
  zai: {
    name: 'Z.AI / GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    key_env: 'GLM_API_KEY',
    models: ['glm-4-plus', 'glm-4-air'],
  },
  'kimi-coding': {
    name: 'Kimi',
    base_url: 'https://api.moonshot.cn/v1',
    key_env: 'KIMI_API_KEY',
    models: ['kimi-latest', 'moonshot-v1-128k'],
  },
  minimax: {
    name: 'MiniMax',
    base_url: 'https://api.minimax.io/v1',
    key_env: 'MINIMAX_API_KEY',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-Lightning'],
  },
  xiaomi: {
    name: 'Xiaomi MiMo',
    base_url: '',
    key_env: 'XIAOMI_API_KEY',
    models: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'],
  },
  nvidia: {
    name: 'NVIDIA NIM',
    base_url: 'https://integrate.api.nvidia.com/v1',
    key_env: 'NVIDIA_API_KEY',
    models: [
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
    ],
  },
}

const BUILTIN_PROVIDER_IDS = new Set(Object.keys(BUILTIN_PROVIDER_PRESETS))

function resolveBuiltinProviderId(keyEnv: string, providerId?: string): string {
  const hinted = providerId?.trim()
  if (hinted && BUILTIN_PROVIDER_PRESETS[hinted]) return hinted
  for (const [id, preset] of Object.entries(BUILTIN_PROVIDER_PRESETS)) {
    if (preset.key_env === keyEnv.trim()) return id
  }
  return ''
}

function catalogCustomRow(
  id: string,
  next: { name: string; base_url: string },
): Record<string, unknown> | null {
  if (id === 'manifest' || BUILTIN_PROVIDER_IDS.has(id)) return null
  return {
    name: id,
    title: next.name,
    base_url: next.base_url,
    api_mode: 'chat_completions',
  }
}

function providerBlockFromEntry(
  entry: CatalogFile['providers'][number],
): Record<string, unknown> {
  const block: Record<string, unknown> = {}
  if (entry.name) block.name = entry.name
  if (entry.base_url) block.base_url = entry.base_url
  if (entry.key_env) block.key_env = entry.key_env
  if (Array.isArray(entry.models)) block.models = entry.models
  return block
}

function mergeProviderCatalogEntry(input: {
  id: string
  name?: string
  base_url?: string
  key_env?: string
  models?: Array<string>
}): CatalogFile['providers'][number] {
  const id = input.id.trim()
  const file = mergeCatalog()
  const prev = file.providers.find((entry) => entry.id === id)
  const preset = BUILTIN_PROVIDER_PRESETS[id]
  const next = {
    id,
    name: input.name?.trim() || prev?.name || preset?.name || id,
    base_url:
      input.base_url?.trim() ?? prev?.base_url ?? preset?.base_url ?? '',
    key_env: input.key_env?.trim() ?? prev?.key_env ?? preset?.key_env ?? '',
    models:
      input.models ??
      (prev?.models?.length ? prev.models : (preset?.models ?? [])),
  }
  writeCatalogFile({
    providers: [
      ...file.providers.filter((entry) => entry.id !== id),
      next,
    ].sort((a, b) => a.id.localeCompare(b.id)),
  })
  return next
}

function isRedundantBuiltinProviderBlock(
  providerId: string,
  block: Record<string, unknown>,
): boolean {
  const preset = BUILTIN_PROVIDER_PRESETS[providerId]
  if (!preset) return false
  if (readString(block.api_key)) return false

  const baseUrl =
    readString(block.base_url) || readString(block.api) || readString(block.url)
  if (baseUrl && preset.base_url && baseUrl !== preset.base_url) return false

  const keyEnv = readString(block.key_env)
  if (keyEnv && keyEnv !== preset.key_env) return false

  const allowedKeys = new Set([
    'name',
    'base_url',
    'api',
    'url',
    'key_env',
    'models',
    'default_model',
    'model',
    'enabled',
    'discover_models',
    'provider',
  ])
  return Object.keys(block).every((key) => allowedKeys.has(key))
}

/** Remove stale ``providers.<builtin>`` blocks that duplicate Hermes defaults. */
function pruneRedundantBuiltinProviderFromAllProfiles(
  providerId: string,
): void {
  if (!BUILTIN_PROVIDER_IDS.has(providerId)) return
  for (const profile of listProfiles()) {
    const config = readProfile(profile.name).config
    const providers = { ...(asRecord(config.providers) || {}) }
    const block = asRecord(providers[providerId])
    if (!block || !isRedundantBuiltinProviderBlock(providerId, block)) continue
    delete providers[providerId]
    updateProfileConfig(profile.name, { providers: null })
    updateProfileConfig(profile.name, { providers })
  }
}

function pruneAllRedundantBuiltinProvidersFromProfiles(): void {
  for (const id of BUILTIN_PROVIDER_IDS) {
    pruneRedundantBuiltinProviderFromAllProfiles(id)
  }
}

function syncProviderToAllProfiles(
  entry: CatalogFile['providers'][number],
): void {
  if (BUILTIN_PROVIDER_IDS.has(entry.id)) {
    pruneRedundantBuiltinProviderFromAllProfiles(entry.id)
    return
  }
  patchAllProfileProviders(
    entry.id,
    providerBlockFromEntry(entry),
    catalogCustomRow(entry.id, {
      name: entry.name || entry.id,
      base_url: entry.base_url || '',
    }),
  )
}

function catalogPath(): string {
  return path.join(getStateDir(), 'provider-catalog.json')
}

function isCatalogEnvKey(name: string): boolean {
  return /API_KEY|ACCESS_TOKEN|_SECRET/i.test(name)
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return '••••'
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Shared provider catalog reads only the default profile — configs are synced on write. */
const CATALOG_SOURCE_PROFILE = 'default'

function defaultEnvPath(): string {
  return path.join(resolveProfileHermesHome(CATALOG_SOURCE_PROFILE), '.env')
}

function uniqueEnvPaths(createMissing = false): Array<string> {
  const seen = new Set<string>()
  const paths: Array<string> = []
  for (const profile of listProfiles()) {
    const envPath = path.join(resolveProfileHermesHome(profile.name), '.env')
    if (!fs.existsSync(envPath)) {
      if (!createMissing) continue
      if (seen.has(envPath)) continue
      seen.add(envPath)
      paths.push(envPath)
      continue
    }
    try {
      const resolved = fs.realpathSync(envPath)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      paths.push(resolved)
    } catch {
      if (seen.has(envPath)) continue
      seen.add(envPath)
      paths.push(envPath)
    }
  }
  return paths
}

function readEnvMap(envPath: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(envPath, 'utf-8'))
  } catch {
    return {}
  }
}

function lookupKeyValue(name: string): string {
  if (!name) return ''
  return readEnvMap(defaultEnvPath())[name] || ''
}

/**
 * Resolve a catalog provider's real base URL and API key, server-side only.
 * Callers (e.g. the Claude Code settings bridge) can copy these into another
 * config file without ever sending the raw secret to the browser.
 */
export function getCatalogProviderCredential(
  providerId: string,
): { baseUrl: string; apiKey: string; keyEnv: string } | null {
  const id = providerId.trim()
  if (!id) return null
  const entry = mergeCatalog().providers.find((item) => item.id === id)
  const preset = BUILTIN_PROVIDER_PRESETS[id]
  if (!entry && !preset) return null
  const baseUrl = entry?.base_url || preset?.base_url || ''
  const keyEnv = entry?.key_env || preset?.key_env || ''
  const apiKey = keyEnv ? lookupKeyValue(keyEnv) : ''
  return { baseUrl, apiKey, keyEnv }
}

function writeKeyToAllEnvs(name: string, value: string): void {
  const secret = value.trim()
  if (!name.trim() || !secret) return
  for (const envPath of uniqueEnvPaths(true)) {
    const current = readEnvMap(envPath)
    current[name.trim()] = secret
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    fs.writeFileSync(envPath, stringifyEnv(current), 'utf-8')
  }
}

function removeKeyFromAllEnvs(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  for (const envPath of uniqueEnvPaths()) {
    const current = readEnvMap(envPath)
    if (!(trimmed in current)) continue
    delete current[trimmed]
    fs.writeFileSync(envPath, stringifyEnv(current), 'utf-8')
  }
}

function collectKeyEnvRefs(excludeProviderId?: string): Set<string> {
  const refs = new Set<string>()
  for (const entry of mergeCatalog().providers) {
    if (excludeProviderId && entry.id === excludeProviderId) continue
    if (entry.key_env) refs.add(entry.key_env)
  }
  return refs
}

function readCatalogFile(): CatalogFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(catalogPath(), 'utf-8'),
    ) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { providers: [] }
    }
    const rec = parsed as Record<string, unknown>
    if (Array.isArray(rec.providers)) {
      return {
        providers: rec.providers.flatMap((raw) => {
          const item = asRecord(raw)
          if (!item) return []
          const id = readString(item.id)
          if (!id) return []
          return [
            {
              id,
              name: readString(item.name) || id,
              base_url: readString(item.base_url),
              key_env: readString(item.key_env),
              models: Array.isArray(item.models)
                ? item.models.filter((m): m is string => typeof m === 'string')
                : [],
            },
          ]
        }),
      }
    }
    // Migrate the previous keys/fallbacks catalog file.
    const fallbacks = Array.isArray(rec.fallbacks) ? rec.fallbacks : []
    const migrated = new Map<string, CatalogFile['providers'][number]>()
    for (const raw of fallbacks) {
      const item = asRecord(raw)
      if (!item) continue
      const id = readString(item.provider)
      if (!id) continue
      const prev = migrated.get(id) || { id, name: id, models: [] }
      const model = readString(item.model)
      migrated.set(id, {
        ...prev,
        base_url: prev.base_url || readString(item.base_url),
        key_env: prev.key_env || readString(item.key_env),
        models:
          model && !prev.models?.includes(model)
            ? [...(prev.models || []), model]
            : prev.models,
      })
    }
    return { providers: [...migrated.values()] }
  } catch {
    return { providers: [] }
  }
}

function writeCatalogFile(file: CatalogFile): void {
  const dir = path.dirname(catalogPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(catalogPath(), `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
}

function discoverProvidersFromConfig(
  config: Record<string, unknown>,
): CatalogFile['providers'] {
  const byId = new Map<string, CatalogFile['providers'][number]>()

  const upsert = (entry: CatalogFile['providers'][number]) => {
    const prev = byId.get(entry.id)
    if (!prev) {
      byId.set(entry.id, entry)
      return
    }
    byId.set(entry.id, {
      id: entry.id,
      name: prev.name || entry.name,
      base_url: prev.base_url || entry.base_url,
      key_env: prev.key_env || entry.key_env,
      models: [...new Set([...(prev.models || []), ...(entry.models || [])])],
    })
  }

  const providers = asRecord(config.providers) || {}
  for (const [id, raw] of Object.entries(providers)) {
    const rec = asRecord(raw)
    if (!rec) continue
    const models = Array.isArray(rec.models)
      ? rec.models.filter((m): m is string => typeof m === 'string')
      : []
    const defaultModel = readString(rec.default_model)
    upsert({
      id,
      name: readString(rec.name) || id,
      base_url: readString(rec.base_url),
      key_env: readString(rec.key_env),
      models: defaultModel ? [...models, defaultModel] : models,
    })
  }
  const custom = Array.isArray(config.custom_providers)
    ? config.custom_providers
    : []
  for (const raw of custom) {
    const rec = asRecord(raw)
    if (!rec) continue
    const id = readString(rec.name)
    if (!id) continue
    upsert({
      id,
      name: readString(rec.title) || id,
      base_url: readString(rec.base_url),
      key_env:
        readString(rec.key_env) ||
        (isCatalogEnvKey(readString(rec.api_key))
          ? readString(rec.api_key)
          : ''),
      models: [],
    })
  }
  const fallbacks = Array.isArray(config.fallback_providers)
    ? config.fallback_providers
    : []
  for (const raw of fallbacks) {
    const rec = asRecord(raw)
    if (!rec) continue
    const id = readString(rec.provider)
    if (!id) continue
    const model = readString(rec.model)
    upsert({
      id,
      name: id,
      base_url: readString(rec.base_url),
      key_env: readString(rec.key_env),
      models: model ? [model] : [],
    })
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function discoverProviders(): CatalogFile['providers'] {
  return discoverProvidersFromConfig(readProfile(CATALOG_SOURCE_PROFILE).config)
}

function mergeCatalog(): CatalogFile {
  const stored = readCatalogFile()
  const discovered = discoverProviders()
  const byId = new Map<string, CatalogFile['providers'][number]>()
  for (const entry of [...stored.providers, ...discovered]) {
    const prev = byId.get(entry.id)
    if (!prev) {
      byId.set(entry.id, entry)
      continue
    }
    byId.set(entry.id, {
      id: entry.id,
      name: prev.name || entry.name,
      base_url: prev.base_url || entry.base_url,
      key_env: prev.key_env || entry.key_env,
      models: [...new Set([...(prev.models || []), ...(entry.models || [])])],
    })
  }
  const merged = {
    providers: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
  if (stored.providers.length === 0 && merged.providers.length > 0) {
    writeCatalogFile(merged)
  }
  return merged
}

const PROVIDER_CATALOG_CACHE_TTL_MS = 5_000
let providerCatalogCache:
  | { catalog: ProviderCatalog; expiresAt: number }
  | undefined

export function __resetProviderCatalogCacheForTests(): void {
  providerCatalogCache = undefined
}

function buildProviderCatalog(): ProviderCatalog {
  pruneAllRedundantBuiltinProvidersFromProfiles()
  return {
    providers: mergeCatalog()
      .providers.filter(
        (entry) => entry.id !== 'manifest' && entry.id !== 'custom',
      )
      .map((entry) => {
        const value = lookupKeyValue(entry.key_env || '')
        return {
          id: entry.id,
          name: entry.name || entry.id,
          base_url: entry.base_url || '',
          key_env: entry.key_env || '',
          models: [...new Set(entry.models || [])],
          keyConfigured: Boolean(value),
          maskedKey: value ? maskSecret(value) : '',
        }
      }),
  }
}

/**
 * Every provider configured on the Hermes "Model & Provider" page, reshaped
 * for the Claude Code settings panel's provider dropdown.
 *
 * We deliberately do NOT filter this down to the builtin `anthropic` entry.
 * Claude Code talks the Anthropic Messages API directly against
 * ANTHROPIC_BASE_URL, so most Hermes providers (OpenAI-compatible gateways)
 * won't work — but the user may have added a custom provider that IS an
 * Anthropic-compatible gateway/proxy, and we can't tell protocol from the
 * catalog data alone. Surface everything the user already configured and
 * let them pick; the panel shows a hint rather than hiding options.
 */
export function listCatalogProvidersForClaudeCode(): Array<{
  id: string
  name: string
  baseUrl: string
  keyEnv: string
  keyConfigured: boolean
  maskedKey: string
  models: Array<string>
}> {
  return getProviderCatalog().providers.map((entry) => ({
    id: entry.id,
    name: entry.name,
    baseUrl: entry.base_url,
    keyEnv: entry.key_env,
    keyConfigured: entry.keyConfigured,
    maskedKey: entry.maskedKey,
    models: entry.models,
  }))
}

export function getProviderCatalog(): ProviderCatalog {
  const now = Date.now()
  if (
    providerCatalogCache &&
    providerCatalogCache.expiresAt > now
  ) {
    return providerCatalogCache.catalog
  }
  const catalog = buildProviderCatalog()
  providerCatalogCache = {
    catalog,
    expiresAt: now + PROVIDER_CATALOG_CACHE_TTL_MS,
  }
  return catalog
}

function patchAllProfileProviders(
  providerId: string,
  patch: Record<string, unknown>,
  customRow?: Record<string, unknown> | null,
): void {
  for (const profile of listProfiles()) {
    const config = readProfile(profile.name).config
    const nextPatch: Record<string, unknown> = {
      providers: { [providerId]: patch },
    }
    if (customRow) {
      const list = Array.isArray(config.custom_providers)
        ? [...config.custom_providers]
        : []
      const filtered = list.filter((raw) => {
        const rec = asRecord(raw)
        return rec ? readString(rec.name) !== providerId : true
      })
      filtered.push(customRow)
      nextPatch.custom_providers = filtered
    }
    updateProfileConfig(profile.name, nextPatch)
  }
}

function extractProviderKeyEnv(
  config: Record<string, unknown>,
  providerId: string,
): string {
  const providers = asRecord(config.providers) || {}
  const block = asRecord(providers[providerId])
  if (block) {
    const fromBlock = readString(block.key_env)
    if (fromBlock) return fromBlock
  }
  const custom = Array.isArray(config.custom_providers)
    ? config.custom_providers
    : []
  for (const raw of custom) {
    const rec = asRecord(raw)
    if (!rec || readString(rec.name) !== providerId) continue
    return (
      readString(rec.key_env) ||
      (isCatalogEnvKey(readString(rec.api_key)) ? readString(rec.api_key) : '')
    )
  }
  return ''
}

/** Strip providers.<id>, custom_providers row, and matching fallbacks from every profile. */
function removeProviderFromAllProfiles(providerId: string): string {
  let keyEnv = ''
  for (const profile of listProfiles()) {
    const config = { ...readProfile(profile.name).config }
    keyEnv = keyEnv || extractProviderKeyEnv(config, providerId)

    const providers = { ...(asRecord(config.providers) || {}) }
    delete providers[providerId]

    const custom = Array.isArray(config.custom_providers)
      ? config.custom_providers.filter((raw) => {
          const rec = asRecord(raw)
          return rec ? readString(rec.name) !== providerId : true
        })
      : []

    const fallbacks = Array.isArray(config.fallback_providers)
      ? config.fallback_providers.filter((raw) => {
          const rec = asRecord(raw)
          return rec ? readString(rec.provider) !== providerId : true
        })
      : []

    // Nested provider keys cannot be deleted via deepMerge — clear then rewrite.
    updateProfileConfig(profile.name, { providers: null })
    updateProfileConfig(profile.name, {
      providers,
      custom_providers: custom,
      fallback_providers: fallbacks,
    })
  }
  return keyEnv
}

export function isBuiltinCatalogProvider(providerId: string): boolean {
  return BUILTIN_PROVIDER_IDS.has(providerId.trim())
}

/**
 * Remove a provider.
 * - Custom: drop card + all profile config (+ env key if unused elsewhere)
 * - Builtin: clear any legacy providers.<id> + env key; UI card remains as Key required
 */
export function removeCatalogProvider(providerId: string): ProviderCatalog {
  const id = providerId.trim()
  if (!id) throw new Error('Provider id is required')
  if (id === 'custom' || id === 'manifest') {
    throw new Error(`Cannot remove provider ${id}`)
  }

  const file = mergeCatalog()
  const stored = file.providers.find((entry) => entry.id === id)
  const preset = BUILTIN_PROVIDER_PRESETS[id]
  const keyEnv =
    removeProviderFromAllProfiles(id) ||
    stored?.key_env ||
    preset?.key_env ||
    ''

  writeCatalogFile({
    providers: file.providers.filter((entry) => entry.id !== id),
  })

  if (keyEnv && !collectKeyEnvRefs(id).has(keyEnv)) {
    removeKeyFromAllEnvs(keyEnv)
  }

  providerCatalogCache = undefined
  return getProviderCatalog()
}

export function upsertCatalogProvider(input: {
  id: string
  name?: string
  base_url?: string
  key_env?: string
  key_value?: string
  models?: Array<string>
}): ProviderCatalog {
  const id = input.id.trim()
  if (!id) throw new Error('Provider id is required')
  const next = mergeProviderCatalogEntry(input)
  syncProviderToAllProfiles(next)
  if (next.key_env && input.key_value?.trim()) {
    if (!isCatalogEnvKey(next.key_env)) {
      throw new Error('Only API key / token env names can be stored')
    }
    writeKeyToAllEnvs(next.key_env, input.key_value)
  }
  providerCatalogCache = undefined
  return getProviderCatalog()
}

export function upsertCatalogKey(
  name: string,
  value: string,
  providerId?: string,
): ProviderCatalog {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Key name is required')
  if (!isCatalogEnvKey(trimmed)) {
    throw new Error(
      'Only API key / token env names can be added to the catalog',
    )
  }
  writeKeyToAllEnvs(trimmed, value)
  const builtinId = resolveBuiltinProviderId(trimmed, providerId)
  if (builtinId) {
    const next = mergeProviderCatalogEntry({ id: builtinId, key_env: trimmed })
    syncProviderToAllProfiles(next)
  }
  providerCatalogCache = undefined
  return getProviderCatalog()
}

function currentProviderId(config: Record<string, unknown>): string {
  const nested = asRecord(config.model)
  if (nested) {
    const nestedProvider = readString(nested.provider)
    if (nestedProvider) return nestedProvider
  }
  return readString(config.provider)
}

function currentModelId(config: Record<string, unknown>): string {
  if (typeof config.model === 'string') return config.model.trim()
  const nested = asRecord(config.model)
  return nested ? readString(nested.default) : ''
}

export function readProfileProviderSelection(
  name: string,
): ProfileProviderSelection {
  const config = readProfile(name).config
  const fallbacks = Array.isArray(config.fallback_providers)
    ? config.fallback_providers
    : []
  const first = asRecord(fallbacks[0])
  return {
    provider: currentProviderId(config),
    model: currentModelId(config),
    fallbackProvider: first ? readString(first.provider) : '',
    fallbackModel: first ? readString(first.model) : '',
  }
}

export function updateProfileFallback(
  name: string,
  providerId: string,
  modelId: string,
): ProfileProviderSelection {
  const provider = providerId.trim()
  const model = modelId.trim()
  if (!provider || !model) {
    updateProfileConfig(name, { fallback_providers: [] })
    return readProfileProviderSelection(name)
  }
  const catalog = getProviderCatalog()
  const entry = catalog.providers.find((item) => item.id === provider)
  const preset = BUILTIN_PROVIDER_PRESETS[provider]
  updateProfileConfig(name, {
    fallback_providers: [
      {
        provider,
        model,
        base_url: entry?.base_url || preset?.base_url || undefined,
        key_env: entry?.key_env || preset?.key_env || undefined,
      },
    ],
  })
  return readProfileProviderSelection(name)
}

/** @deprecated fallback catalog entries are derived from providers now */
export function fallbackEntryId(entry: {
  provider: string
  model: string
  base_url?: string
}): string {
  return [entry.provider, entry.model, entry.base_url || ''].join('::')
}
