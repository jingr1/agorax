/**
 * Hermes usage client.
 *
 * Prefer local profile `state.db` (no Dashboard :9119). Optionally fall back
 * to the dashboard analytics endpoint when `HERMES_USE_DASHBOARD=1`.
 *
 * Non-Hermes runtimes (Claude Code / Codex) are sourced separately via
 * session scanners.
 */
import {
  dashboardFetch,
  shouldUseDashboard,
} from '../gateway-capabilities'
import { scanHermesSessions } from './hermes-session-scanner'

const REQUEST_TIMEOUT_MS = 8_000

export interface GatewayUsageRecord {
  request_id?: string
  provider_id?: string
  provider_name?: string
  model?: string
  request_model?: string
  app_type?: string
  agent_id?: string
  profile?: string
  runtime?: string
  task?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  reasoning_tokens?: number
  input_cost_usd?: number
  output_cost_usd?: number
  cache_read_cost_usd?: number
  cache_creation_cost_usd?: number
  total_cost_usd?: number
  status_code?: number
  latency_ms?: number
  created_at?: number
}

export interface GatewayAnalyticsResponse {
  ok?: boolean
  error?: string
  days?: number
  records?: Array<GatewayUsageRecord>
  totals?: {
    requests?: number
    input_tokens?: number
    output_tokens?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
    total_cost_usd?: number
  }
}

function readNum(value: number | undefined): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0
  return Math.max(0, value)
}

/**
 * Expand dashboard `/api/analytics/usage` into per-request shaped records.
 *
 * We use `daily` for accurate totals (it includes cache reads) and distribute
 * each day's tokens across the models reported in `by_model` proportional to
 * each model's input-token share. Models with zero tokens get a negligible
 * row so they still appear in the breakdown without distorting totals.
 */
function expandDashboardAnalytics(
  data: Record<string, unknown>,
): GatewayUsageRecord[] {
  const records: GatewayUsageRecord[] = []
  const daily = Array.isArray(data.daily) ? data.daily : []
  const byModel = Array.isArray(data.by_model) ? data.by_model : []

  const modelShares = byModel
    .map((m) => {
      if (!m || typeof m !== 'object') return null
      const row = m as Record<string, unknown>
      return {
        model: String(row.model ?? 'unknown'),
        input: readNum(row.input_tokens as number),
      }
    })
    .filter((x): x is { model: string; input: number } => x !== null)

  const totalModelInput = modelShares.reduce((s, m) => s + m.input, 0)

  for (const day of daily) {
    if (!day || typeof day !== 'object') continue
    const d = day as Record<string, unknown>
    const dayStr =
      typeof d.day === 'string' ? d.day : new Date().toISOString().slice(0, 10)
    const createdAt = new Date(dayStr).getTime()

    const inputTokens = readNum(d.input_tokens as number)
    const outputTokens = readNum(d.output_tokens as number)
    const cacheReadTokens = readNum(d.cache_read_tokens as number)
    const cacheCreationTokens = readNum(d.cache_creation_tokens as number)
    const reasoningTokens = readNum(d.reasoning_tokens as number)
    const totalCost = readNum(d.estimated_cost as number)

    if (modelShares.length === 0) {
      records.push({
        request_id: `gw-${dayStr}`,
        provider_id: 'hermes',
        provider_name: 'hermes',
        model: 'unknown',
        agent_id: 'hermes',
        profile: 'default',
        runtime: 'hermes',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        reasoning_tokens: reasoningTokens,
        total_cost_usd: totalCost,
        created_at: createdAt,
      })
      continue
    }

    // Pro-rata distribution by input token share. If totalModelInput is zero
    // (all models report 0 input) fall back to equal split.
    const denominator = totalModelInput > 0 ? totalModelInput : modelShares.length
    for (const share of modelShares) {
      const weight =
        totalModelInput > 0 ? share.input / denominator : 1 / denominator
      records.push({
        request_id: `gw-${dayStr}-${share.model}`,
        provider_id: 'hermes',
        provider_name: 'hermes',
        model: share.model,
        agent_id: 'hermes',
        profile: 'default',
        runtime: 'hermes',
        input_tokens: Math.round(inputTokens * weight),
        output_tokens: Math.round(outputTokens * weight),
        cache_read_tokens: Math.round(cacheReadTokens * weight),
        cache_creation_tokens: Math.round(cacheCreationTokens * weight),
        reasoning_tokens: Math.round(reasoningTokens * weight),
        total_cost_usd: Math.round(totalCost * weight * 1e12) / 1e12,
        created_at: createdAt,
      })
    }
  }

  return records
}

function dedupeModels(records: GatewayUsageRecord[]): GatewayUsageRecord[] {
  const seen = new Set<string>()
  return records.filter((r) => {
    const key = `${r.created_at}-${r.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function fetchGatewayAnalytics(
  days: number,
): Promise<GatewayAnalyticsResponse> {
  const windowDays = Math.max(1, days)
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000
  const localRecords = dedupeModels(scanHermesSessions(sinceMs))
  if (localRecords.length > 0 || !shouldUseDashboard()) {
    return {
      ok: true,
      days: windowDays,
      records: localRecords,
    }
  }

  const res = await dashboardFetch(
    `/api/analytics/usage?days=${encodeURIComponent(String(windowDays))}`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      error: `HTTP ${res.status}: ${text || res.statusText}`,
      days: windowDays,
      records: localRecords,
    }
  }

  const data = (await res.json()) as Record<string, unknown>
  const records = dedupeModels(expandDashboardAnalytics(data))
  const totals = data.totals as GatewayAnalyticsResponse['totals'] | undefined

  return {
    ok: true,
    days: windowDays,
    records: records.length > 0 ? records : localRecords,
    totals,
  }
}
