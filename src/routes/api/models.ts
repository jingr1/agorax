import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  ensureGatewayCoreProbed,
  getGatewayCapabilities,
} from '../../server/hermes-api'
import { BEARER_TOKEN, HERMES_API } from '../../server/gateway-capabilities'
import {
  ensureDiscovery,
  ensureProviderInConfig,
  getDiscoveredModels,
} from '../../server/local-provider-discovery'
import { readHermesEnv } from '../../server/stt-transcription'
import { BUILTIN_PROVIDER_PRESETS } from '../../server/provider-catalog'

const HERMES_HOME =
  process.env.HERMES_HOME ??
  process.env.HERMES_HOME ??
  path.join(os.homedir(), '.hermes')
const MODELS_PATH = path.join(HERMES_HOME, 'models.json')
const CONFIG_PATH = path.join(HERMES_HOME, 'config.yaml')
const AUTH_PATH = path.join(HERMES_HOME, 'auth.json')
const PROVIDER_MODELS_CACHE_PATH = path.join(
  HERMES_HOME,
  'provider_models_cache.json',
)

type ModelEntry = {
  provider?: string
  id?: string
  name?: string
  [key: string]: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  return {}
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeModel(entry: unknown): ModelEntry | null {
  if (typeof entry === 'string') {
    const id = entry.trim()
    if (!id) return null
    return {
      id,
      name: id,
      provider: id.includes('/') ? id.split('/')[0] : 'unknown',
    }
  }
  const record = asRecord(entry)
  const id =
    readString(record.id) || readString(record.name) || readString(record.model)
  if (!id) return null
  return {
    ...record,
    id,
    name:
      readString(record.name) ||
      readString(record.display_name) ||
      readString(record.label) ||
      id,
    provider:
      readString(record.provider) ||
      readString(record.owned_by) ||
      (id.includes('/') ? id.split('/')[0] : 'unknown'),
  }
}

export function mergeModelEntries(
  ...sources: Array<Array<ModelEntry>>
): Array<ModelEntry> {
  const merged: Array<ModelEntry> = []
  const seen = new Set<string>()

  for (const source of sources) {
    for (const model of source) {
      const normalized = normalizeModel(model)
      if (!normalized || !normalized.id || seen.has(normalized.id)) continue
      merged.push(normalized)
      seen.add(normalized.id!)
    }
  }

  return merged
}

/**
 * Read user-configured models from active profile's models.json.
 */
function readClaudeModelsJson(): Array<ModelEntry> {
  try {
    if (!fs.existsSync(MODELS_PATH)) return []
    const raw = fs.readFileSync(MODELS_PATH, 'utf-8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries
      .map((entry: unknown): ModelEntry | null => {
        const record = asRecord(entry)
        // models.json uses "model" field for the model ID
        const modelId = readString(record.model) || readString(record.id)
        if (!modelId) return null
        return {
          id: modelId,
          name: readString(record.name) || modelId,
          provider: readString(record.provider) || 'unknown',
        }
      })
      .filter((entry): entry is ModelEntry => entry !== null)
  } catch {
    return []
  }
}

const DEFAULT_ACCEPTED_TIMEOUT_S = 120
const DEFAULT_HANDOFF_TIMEOUT_S = 300
const LIVE_MODEL_CACHE_TTL_MS = 60_000

type LiveModelEndpoint = {
  provider: string
  baseUrl: string
  apiKey?: string
}

type LiveModelCacheEntry = {
  expiresAt: number
  models: Array<ModelEntry>
}

const liveModelCache = new Map<string, LiveModelCacheEntry>()

function readStreamTimeouts(): {
  streamAcceptedTimeoutMs: number
  streamHandoffTimeoutMs: number
} {
  let acceptedS = DEFAULT_ACCEPTED_TIMEOUT_S
  let handoffS = DEFAULT_HANDOFF_TIMEOUT_S
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      const ws =
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).workspace === 'object'
          ? ((parsed as Record<string, unknown>).workspace as Record<
              string,
              unknown
            >)
          : {}
      if (
        typeof ws.stream_accepted_timeout === 'number' &&
        ws.stream_accepted_timeout > 0
      )
        acceptedS = ws.stream_accepted_timeout
      if (
        typeof ws.stream_handoff_timeout === 'number' &&
        ws.stream_handoff_timeout > 0
      )
        handoffS = ws.stream_handoff_timeout
    }
  } catch {
    // fall through to defaults
  }
  const envAccepted = parseInt(process.env.STREAM_ACCEPTED_TIMEOUT_MS ?? '', 10)
  const envHandoff = parseInt(process.env.STREAM_HANDOFF_TIMEOUT_MS ?? '', 10)
  return {
    streamAcceptedTimeoutMs:
      Number.isFinite(envAccepted) && envAccepted > 0
        ? envAccepted
        : acceptedS * 1000,
    streamHandoffTimeoutMs:
      Number.isFinite(envHandoff) && envHandoff > 0
        ? envHandoff
        : handoffS * 1000,
  }
}

/**
 * Read the default model from active profile's config.yaml using a proper YAML parser.
 */
function readClaudeDefaultModel(): ModelEntry | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const config = parsed as Record<string, unknown>
    let modelId = ''
    let provider = ''
    const modelField = config.model
    if (typeof modelField === 'string') {
      modelId = modelField
      provider = (config.provider as string) || 'unknown'
    } else if (modelField && typeof modelField === 'object') {
      const modelObj = modelField as Record<string, unknown>
      modelId = (modelObj.default as string) || ''
      provider =
        (modelObj.provider as string) ||
        (config.provider as string) ||
        'unknown'
    }
    if (!modelId) return null
    return { id: modelId, name: modelId, provider }
  } catch {
    return null
  }
}

/**
 * Read providers.*.models (+ provider default model) and model_aliases
 * from ~/.hermes/config.yaml so the picker reflects the user's full Hermes
 * catalog, not just /v1/models + models.json + local discovery. Fix for #569.
 */
function resolveConfiguredSecret(value: unknown): string {
  const raw = readString(value)
  if (!raw) return ''
  const envMatch = raw.match(/^\$\{?([A-Z0-9_]+)\}?$/i)
  if (envMatch) return process.env[envMatch[1]] ?? ''
  return raw
}

/** Resolve API key from a Hermes provider block (supports key_env / api_key_env). */
export function resolveProviderApiKey(block: Record<string, unknown>): string {
  const direct =
    resolveConfiguredSecret(block.api_key) ||
    resolveConfiguredSecret(block.apiKey) ||
    resolveConfiguredSecret(block.token)
  if (direct) return direct

  const envName =
    readString(block.key_env) ||
    readString(block.keyEnv) ||
    readString(block.api_key_env) ||
    readString(block.apiKeyEnv)
  if (!envName) return ''
  const hermesEnv = readHermesEnv(HERMES_HOME)
  return process.env[envName] ?? hermesEnv[envName] ?? ''
}

/**
 * Resolve a provider API key from auth.json credential_pool source/label
 * (e.g. deepseek → env:DEEPSEEK_API_KEY). Used when fallback_providers /
 * live endpoints omit key_env.
 */
export function resolveApiKeyFromAuthPool(providerId: string): string {
  const wanted = providerId.trim()
  if (!wanted) return ''
  try {
    if (!fs.existsSync(AUTH_PATH)) return ''
    const auth = asRecord(JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')))
    const pool = asRecord(auth.credential_pool)
    const poolKey =
      Object.keys(pool).find(
        (key) => key.toLowerCase() === wanted.toLowerCase(),
      ) ?? ''
    if (!poolKey) return ''
    const entries = pool[poolKey]
    if (!Array.isArray(entries) || entries.length === 0) return ''
    const hermesEnv = readHermesEnv(HERMES_HOME)
    for (const entry of entries) {
      const block = asRecord(entry)
      const source = readString(block.source)
      const envMatch = source.match(/^env:([A-Z0-9_]+)$/i)
      const candidates = [
        envMatch?.[1] ?? '',
        readString(block.label),
        readString(block.key_env),
      ].filter(Boolean)
      for (const envName of candidates) {
        const value = process.env[envName] ?? hermesEnv[envName] ?? ''
        if (value) return value
      }
    }
  } catch {
    // ignore malformed auth.json
  }
  return ''
}

/** Providers referenced by config.yaml (default / providers / custom / fallback). */
export function listConfigReferencedProviders(
  config: Record<string, unknown>,
): Array<string> {
  const out = new Set<string>()
  const modelBlock = asRecord(config.model)
  const defaultProvider =
    readString(modelBlock.provider) || readString(config.provider)
  if (defaultProvider) out.add(defaultProvider)

  for (const providerId of Object.keys(asRecord(config.providers))) {
    if (providerId.trim()) out.add(providerId.trim())
  }

  if (Array.isArray(config.custom_providers)) {
    for (const entry of config.custom_providers) {
      const block = asRecord(entry)
      const providerId =
        readString(block.name) ||
        readString(block.id) ||
        readString(block.provider)
      if (providerId) out.add(providerId)
    }
  }

  if (Array.isArray(config.fallback_providers)) {
    for (const entry of config.fallback_providers) {
      const block = asRecord(entry)
      const providerId = readString(block.provider) || readString(block.name)
      if (providerId) out.add(providerId)
    }
  }

  return Array.from(out)
}

/** Builtin Hermes providers with a configured API key in ~/.hermes/.env */
export function listConfiguredBuiltinProviders(
  env: Record<string, string> = readHermesEnv(HERMES_HOME),
): Array<string> {
  const out: Array<string> = []
  for (const [providerId, preset] of Object.entries(BUILTIN_PROVIDER_PRESETS)) {
    const keyEnv = preset.key_env?.trim()
    if (!keyEnv) continue
    if (env[keyEnv]?.trim()) out.push(providerId)
  }
  return out
}

/** Config-referenced providers plus builtins that only need a .env API key. */
export function listModelCatalogProviders(
  config: Record<string, unknown>,
  env: Record<string, string> = readHermesEnv(HERMES_HOME),
): Array<string> {
  return Array.from(
    new Set([
      ...listConfigReferencedProviders(config),
      ...listConfiguredBuiltinProviders(env),
    ]),
  )
}

export function modelsFromBuiltinPresets(
  providerIds: Array<string>,
): Array<ModelEntry> {
  const out: Array<ModelEntry> = []
  for (const providerId of providerIds) {
    const preset = BUILTIN_PROVIDER_PRESETS[providerId]
    if (!preset?.models?.length) continue
    for (const id of preset.models) {
      const modelId = id.trim()
      if (!modelId) continue
      out.push({
        id: modelId,
        name: modelId,
        provider: providerId,
        source: 'builtin-preset',
      })
    }
  }
  return out
}

/**
 * Expand configured providers using Hermes' provider_models_cache.json.
 * Only providers referenced in config are included (keeps picker curated;
 * e.g. fallback deepseek → deepseek-v4-pro + deepseek-v4-flash).
 */
export function modelsFromProviderCache(
  cache: Record<string, unknown>,
  providerIds: Array<string>,
): Array<ModelEntry> {
  const out: Array<ModelEntry> = []
  for (const providerId of providerIds) {
    const cacheKey =
      Object.keys(cache).find(
        (key) => key.toLowerCase() === providerId.toLowerCase(),
      ) ?? providerId
    const entry = cache[cacheKey]
    const models = Array.isArray(entry)
      ? entry
      : Array.isArray(asRecord(entry).models)
        ? (asRecord(entry).models as unknown[])
        : []
    for (const model of models) {
      if (typeof model !== 'string') continue
      const id = model.trim()
      if (!id) continue
      out.push({
        id,
        name: id,
        provider: providerId,
        source: 'provider-cache',
      })
    }
  }
  return out
}

function readCachedModelsForConfigProviders(): Array<ModelEntry> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return []
    const config = asRecord(YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')))
    const env = readHermesEnv(HERMES_HOME)
    const providerIds = listModelCatalogProviders(config, env)
    if (providerIds.length === 0) return []

    const cache = fs.existsSync(PROVIDER_MODELS_CACHE_PATH)
      ? asRecord(
          JSON.parse(fs.readFileSync(PROVIDER_MODELS_CACHE_PATH, 'utf-8')),
        )
      : {}
    return mergeModelEntries(
      modelsFromProviderCache(cache, providerIds),
      modelsFromBuiltinPresets(providerIds),
    )
  } catch {
    return []
  }
}

function normalizeConfiguredBaseUrl(value: unknown): string {
  const raw = readString(value)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function modelsUrlForBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`
}

function readConfiguredLiveModelEndpoints(): Array<LiveModelEndpoint> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return []
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    const config = parsed as Record<string, unknown>
    const endpoints: Array<LiveModelEndpoint> = []
    const seen = new Set<string>()

    const pushEndpoint = (provider: string, block: Record<string, unknown>) => {
      const baseUrl =
        normalizeConfiguredBaseUrl(block.base_url) ||
        normalizeConfiguredBaseUrl(block.baseUrl) ||
        normalizeConfiguredBaseUrl(block.api_base) ||
        normalizeConfiguredBaseUrl(block.apiBase)
      if (!baseUrl) return
      const apiKey =
        resolveProviderApiKey(block) || resolveApiKeyFromAuthPool(provider)
      const key = `${provider}\u0000${baseUrl}`
      if (seen.has(key)) return
      seen.add(key)
      endpoints.push({ provider, baseUrl, apiKey: apiKey || undefined })
    }

    const modelBlock = asRecord(config.model)
    pushEndpoint(
      readString(modelBlock.provider) ||
        readString(config.provider) ||
        'configured',
      modelBlock,
    )

    const providers = asRecord(config.providers)
    for (const [providerId, value] of Object.entries(providers)) {
      pushEndpoint(providerId, asRecord(value))
    }

    // custom_providers + fallback_providers often hold the only base_url
    // for OpenAI-compatible proxies; include them so live /v1/models works.
    const customProviders = config.custom_providers
    if (Array.isArray(customProviders)) {
      for (const entry of customProviders) {
        const block = asRecord(entry)
        const providerId =
          readString(block.name) ||
          readString(block.id) ||
          readString(block.provider)
        if (!providerId) continue
        pushEndpoint(providerId, block)
      }
    }

    const fallbackProviders = config.fallback_providers
    if (Array.isArray(fallbackProviders)) {
      for (const entry of fallbackProviders) {
        const block = asRecord(entry)
        const providerId = readString(block.provider) || readString(block.name)
        if (!providerId) continue
        pushEndpoint(providerId, block)
      }
    }

    // Builtin providers only need ~/.hermes/.env keys — no providers: block.
    const hermesEnv = readHermesEnv(HERMES_HOME)
    for (const providerId of listConfiguredBuiltinProviders(hermesEnv)) {
      const preset = BUILTIN_PROVIDER_PRESETS[providerId]
      if (!preset?.base_url) continue
      pushEndpoint(providerId, {
        base_url: preset.base_url,
        key_env: preset.key_env,
      })
    }

    return endpoints
  } catch {
    return []
  }
}

async function fetchConfiguredLiveModels(): Promise<Array<ModelEntry>> {
  const endpoints = readConfiguredLiveModelEndpoints()
  if (endpoints.length === 0) return []

  const all: Array<ModelEntry> = []
  for (const endpoint of endpoints) {
    const cacheKey = `${endpoint.provider}\u0000${endpoint.baseUrl}`
    const cached = liveModelCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      all.push(...cached.models)
      continue
    }

    let models: Array<ModelEntry> = []
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`
      const response = await fetch(modelsUrlForBase(endpoint.baseUrl), {
        headers,
        signal: AbortSignal.timeout(3_000),
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (
        response.ok &&
        contentType.toLowerCase().includes('application/json')
      ) {
        const payload = asRecord(await response.json())
        const rawModels = Array.isArray(payload.data)
          ? payload.data
          : Array.isArray(payload.models)
            ? payload.models
            : []
        models = rawModels
          .map(normalizeModel)
          .filter((entry): entry is ModelEntry => entry !== null)
          .map((entry) => ({
            ...entry,
            // Always use the Hermes config provider key (e.g. `nvidia`), not the
            // upstream org prefix embedded in API model ids (e.g. `minimaxai`).
            provider: endpoint.provider,
            source: 'live-proxy',
          }))
      }
    } catch {
      models = []
    }

    liveModelCache.set(cacheKey, {
      expiresAt: Date.now() + LIVE_MODEL_CACHE_TTL_MS,
      models,
    })
    all.push(...models)
  }

  return all
}

/**
 * Collect models from a Hermes provider / custom_providers block.
 * Supports both list form (`models: [id, ...]`) and map form
 * (`models: { id: { context_length: ... } }`) used by custom_providers.
 */
function collectModelsFromProviderBlock(
  providerId: string,
  block: Record<string, unknown>,
  pushEntry: (entry: ModelEntry) => void,
): void {
  const providerModels = block.models
  if (Array.isArray(providerModels)) {
    for (const modelEntry of providerModels) {
      if (typeof modelEntry === 'string') {
        const id = modelEntry.trim()
        if (!id) continue
        pushEntry({ id, name: id, provider: providerId })
      } else {
        const record = asRecord(modelEntry)
        const id =
          readString(record.id) ||
          readString(record.model) ||
          readString(record.name)
        if (!id) continue
        pushEntry({
          id,
          name: readString(record.name) || id,
          provider: readString(record.provider) || providerId,
        })
      }
    }
  } else if (providerModels && typeof providerModels === 'object') {
    for (const [modelId, meta] of Object.entries(asRecord(providerModels))) {
      const id = modelId.trim()
      if (!id) continue
      const record = asRecord(meta)
      pushEntry({
        id,
        name: readString(record.name) || readString(record.display_name) || id,
        provider: readString(record.provider) || providerId,
        ...(typeof record.context_length === 'number'
          ? { context_length: record.context_length }
          : {}),
      })
    }
  }

  const providerDefault =
    readString(block.model) ||
    readString(block.default) ||
    readString(block.default_model) ||
    readString(block.defaultModel)
  if (providerDefault) {
    pushEntry({
      id: providerDefault,
      name: providerDefault,
      provider: providerId,
    })
  }
}

/**
 * Build the configured model catalog from a parsed Hermes config object.
 * Exported for unit tests.
 */
export function catalogFromConfig(
  config: Record<string, unknown>,
): Array<ModelEntry> {
  const out: Array<ModelEntry> = []
  const seen = new Set<string>()

  const pushEntry = (entry: ModelEntry) => {
    if (!entry.id || seen.has(entry.id)) return
    out.push(entry)
    seen.add(entry.id)
  }

  const providers = asRecord(config.providers)
  for (const [providerId, value] of Object.entries(providers)) {
    collectModelsFromProviderBlock(providerId, asRecord(value), pushEntry)
  }

  // Hermes custom OpenAI/Anthropic-compatible endpoints. These are the
  // primary place users declare named models (often as a map keyed by id).
  const customProviders = config.custom_providers
  if (Array.isArray(customProviders)) {
    for (const entry of customProviders) {
      const block = asRecord(entry)
      const providerId =
        readString(block.name) ||
        readString(block.id) ||
        readString(block.provider)
      if (!providerId) continue
      collectModelsFromProviderBlock(providerId, block, pushEntry)
    }
  }

  const fallbackProviders = config.fallback_providers
  if (Array.isArray(fallbackProviders)) {
    for (const entry of fallbackProviders) {
      const block = asRecord(entry)
      const providerId = readString(block.provider) || readString(block.name)
      const modelId = readString(block.model) || readString(block.default)
      if (!providerId || !modelId) continue
      pushEntry({
        id: modelId,
        name: modelId,
        provider: providerId,
      })
    }
  }

  const aliases = asRecord(config.model_aliases)
  for (const [alias, target] of Object.entries(aliases)) {
    const aliasId = alias.trim()
    if (!aliasId) continue
    const targetStr = typeof target === 'string' ? target.trim() : ''
    const provider =
      targetStr && targetStr.includes('/') ? targetStr.split('/')[0] : 'alias'
    pushEntry({
      id: aliasId,
      name: targetStr ? `${aliasId} → ${targetStr}` : aliasId,
      provider,
      alias: true,
      target: targetStr || undefined,
    })
  }

  return out
}

/**
 * Read providers.*.models, custom_providers, fallback_providers, and
 * model_aliases from ~/.hermes/config.yaml so the picker reflects the user's
 * configured Hermes catalog. Fix for #569 (+ custom_providers).
 */
function readClaudeConfigCatalog(): Array<ModelEntry> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return []
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    return catalogFromConfig(parsed as Record<string, unknown>)
  } catch {
    return []
  }
}

/**
 * Fallback: fetch models from the hermes-agent /v1/models endpoint.
 */
async function fetchClaudeModels(): Promise<Array<ModelEntry>> {
  const headers: Record<string, string> = {}
  if (BEARER_TOKEN) headers['Authorization'] = `Bearer ${BEARER_TOKEN}`
  const response = await fetch(`${HERMES_API}/v1/models`, { headers })
  if (!response.ok)
    throw new Error(`Hermes models request failed (${response.status})`)
  const payload = asRecord(await response.json())
  const rawModels = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : []
  return rawModels
    .map(normalizeModel)
    .filter((e): e is ModelEntry => e !== null)
}

export const Route = createFileRoute('/api/models')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayCoreProbed()

        try {
          // Primary: read user-configured models from ~/.hermes/models.json
          let models = readClaudeModelsJson()
          let source = 'models.json'

          // Ensure the default model from config.yaml is always first
          const defaultModel = readClaudeDefaultModel()
          if (defaultModel) {
            models = models.filter((m) => m.id !== defaultModel.id)
            models.unshift(defaultModel)
          }

          // Merge providers.*.models + custom_providers + fallback_providers +
          // model_aliases from ~/.hermes/config.yaml so the picker reflects the
          // user's configured Hermes catalog (not the full upstream universe).
          // Fix for #569.
          const configModels = readClaudeConfigCatalog()
          if (configModels.length > 0) {
            models = mergeModelEntries(models, configModels)
            source =
              source === 'models.json'
                ? 'models.json+config.yaml'
                : `${source}+config.yaml`
          }

          // Expand config-referenced providers (e.g. fallback deepseek) using
          // Hermes provider_models_cache.json — same source WebUI uses for the
          // authenticated provider catalog, but scoped to configured providers.
          const cachedProviderModels = readCachedModelsForConfigProviders()
          if (cachedProviderModels.length > 0) {
            models = mergeModelEntries(models, cachedProviderModels)
            source = `${source}+provider-cache`
          }

          // Merge the authoritative Hermes model catalog whenever it is
          // available. Previously, a non-empty models.json stopped here, so the
          // Operations picker only showed the local Workspace subset and drifted
          // from the CLI/backend model universe.
          if (getGatewayCapabilities().models) {
            const hermesModels = await fetchClaudeModels()
            models = mergeModelEntries(models, hermesModels)
            source =
              source === 'models.json'
                ? 'models.json+hermes-agent'
                : 'hermes-agent'
          }

          // Merge live OpenAI-compatible catalogs from base_url entries that
          // already exist in config.yaml. This keeps API keys and proxy URLs on
          // the server while restoring dynamic model discovery for configured
          // upstream proxies. Fix for #473.
          const liveProxyModels = await fetchConfiguredLiveModels()
          if (liveProxyModels.length > 0) {
            models = mergeModelEntries(models, liveProxyModels)
            source = `${source}+live-proxy`
          }

          // Merge auto-discovered local models (Ollama, Atomic Chat, etc.)
          await ensureDiscovery()
          const localModels = getDiscoveredModels()
          models = mergeModelEntries(models, localModels)
          for (const m of localModels) {
            ensureProviderInConfig(m.provider)
          }

          const configuredProviders = Array.from(
            new Set(
              models
                .map((model) =>
                  typeof model.provider === 'string' ? model.provider : '',
                )
                .filter(Boolean),
            ),
          )

          const streamTimeouts = readStreamTimeouts()

          return json({
            ok: true,
            object: 'list',
            data: models,
            models,
            configuredProviders,
            source,
            ...streamTimeouts,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
