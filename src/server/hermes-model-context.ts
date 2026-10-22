/**
 * Hermes-aligned context-window backup (same chain dashboard /api/model/info
 * uses under the hood for catalog models): read ~/.hermes/models_dev_cache.json.
 *
 * Provider/SDK session reports remain the primary source in context-usage.ts.
 * This module never invents a default 200k/1M — unknown → 0.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type ModelsDevCache = {
  mtimeMs: number
  byId: Map<string, number>
}

let cache: ModelsDevCache | null = null

function hermesHome(): string {
  return (
    process.env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes')
  )
}

function cachePath(): string {
  return path.join(hermesHome(), 'models_dev_cache.json')
}

function readLimitContext(entry: unknown): number {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 0
  const record = entry as Record<string, unknown>
  const limit = record.limit
  if (limit && typeof limit === 'object' && !Array.isArray(limit)) {
    const context = Number((limit as Record<string, unknown>).context)
    if (context > 0) return context
  }
  const direct = Number(record.context ?? record.context_window)
  return direct > 0 ? direct : 0
}

function indexModelsDev(raw: unknown): Map<string, number> {
  const byId = new Map<string, number>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return byId

  for (const provider of Object.values(raw as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      continue
    }
    const models = (provider as Record<string, unknown>).models
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue
    for (const [modelId, entry] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const context = readLimitContext(entry)
      if (!(context > 0)) continue
      const id = modelId.trim()
      if (!id) continue
      byId.set(id.toLowerCase(), context)
      const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
      if (bare && !byId.has(bare.toLowerCase())) {
        byId.set(bare.toLowerCase(), context)
      }
    }
  }
  return byId
}

function loadModelsDevIndex(): Map<string, number> {
  const file = cachePath()
  try {
    const stat = fs.statSync(file)
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.byId
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    const byId = indexModelsDev(raw)
    cache = { mtimeMs: stat.mtimeMs, byId }
    return byId
  } catch {
    return cache?.byId ?? new Map()
  }
}

function normalizeModelKey(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ''
  const bare = trimmed.includes('/')
    ? trimmed.slice(trimmed.lastIndexOf('/') + 1)
    : trimmed
  return bare.trim().toLowerCase()
}

/**
 * Lookup a model's context window from Hermes' models.dev disk cache.
 * Exact id / bare id first, then longest substring match.
 */
export function lookupModelsDevContextWindow(model: string): number {
  const want = normalizeModelKey(model)
  if (!want) return 0
  const byId = loadModelsDevIndex()
  if (byId.size === 0) return 0

  const exact = byId.get(want)
  if (exact && exact > 0) return exact

  let best = 0
  let bestLen = 0
  for (const [id, context] of byId) {
    if (!(context > 0)) continue
    if (id.includes(want) || want.includes(id)) {
      const score = Math.min(id.length, want.length)
      if (score > bestLen) {
        bestLen = score
        best = context
      }
    }
  }
  return best
}

/** @internal test helper */
export function clearModelsDevContextCache(): void {
  cache = null
}
