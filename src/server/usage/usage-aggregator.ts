import {
  fetchGatewayAnalytics,
  type GatewayUsageRecord,
} from './gateway-analytics-client'
import { calculateNormalizedCost } from './pricing-engine'
import { runSessionImporter } from './session-importer'
import { withUsageDb } from './usage-db'
import type {
  AgentUsageStats,
  DailyStats,
  ModelUsageStats,
  ProfileUsageStats,
  ProviderUsageStats,
  RequestLogEntry,
  SessionLogEntry,
  UsageDataSource,
  UsageFilters,
  UsageSummary,
} from './usage-types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

function toMs(ts: number | undefined): number {
  if (!ts) return 0
  // Gateway may return seconds or milliseconds; treat >1e11 as ms.
  return ts > 1e11 ? ts : ts * 1000
}

function readNum(value: number | undefined): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0
  return Math.max(0, value)
}

function formatCost(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US', {
    maximumFractionDigits: 12,
    useGrouping: false,
  })
}

export function windowDaysFromRange(range: UsageFilters['range']): number {
  switch (range.kind) {
    case '1d':
      return 1
    case '7d':
      return 7
    case '30d':
      return 30
    case 'custom':
      return Math.max(
        1,
        Math.ceil((range.end - range.start) / MS_PER_DAY),
      )
  }
}

interface RawRecord {
  requestId: string
  agentId: string
  profile: string
  providerId: string
  providerName: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  statusCode: number
  latencyMs: number
  createdAt: number
  dataSource: UsageDataSource
  costMultiplier: string
}

function normalizeGatewayRecord(r: GatewayUsageRecord): RawRecord {
  const providerId = r.provider_id || 'unknown'
  const model = r.model || 'unknown'
  const inputTokens = readNum(r.input_tokens)
  const outputTokens = readNum(r.output_tokens)
  const cacheReadTokens = readNum(r.cache_read_tokens)
  const cacheCreationTokens = readNum(r.cache_creation_tokens)

  return {
    requestId: r.request_id || `gw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    agentId: r.agent_id || r.app_type || 'hermes',
    profile: r.profile || 'default',
    providerId,
    providerName: r.provider_name || providerId,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    statusCode: readNum(r.status_code),
    latencyMs: readNum(r.latency_ms),
    createdAt: toMs(r.created_at),
    dataSource: 'hermes',
    costMultiplier: '1',
  }
}

async function loadHermesRecords(
  start: number,
  end: number,
  filters: Omit<UsageFilters, 'range' | 'dataSource'>,
): Promise<RawRecord[]> {
  const windowDays = Math.max(
    1,
    Math.ceil((end - start) / MS_PER_DAY),
  )
  const gateway = await fetchGatewayAnalytics(windowDays)
  if (!gateway.ok) {
    console.warn('[usage-aggregator] gateway analytics failed:', gateway.error)
    return []
  }

  return (gateway.records ?? [])
    .map(normalizeGatewayRecord)
    .filter((r) => r.createdAt >= start && r.createdAt <= end)
    .filter(applyDimensionFilters(filters))
}

function loadSessionRecords(
  start: number,
  end: number,
  filters: Omit<UsageFilters, 'range' | 'dataSource'>,
  dataSource: UsageDataSource,
): RawRecord[] {
  const table = dataSource === 'claude-code' ? 'claude_code_sessions' : 'codex_sessions'
  const params: Array<string | number> = [start, end]
  const conditions = ['created_at >= ? AND created_at <= ?']

  if (filters.agent) {
    conditions.push('agent_id = ?')
    params.push(filters.agent)
  }
  if (filters.profile) {
    conditions.push('profile = ?')
    params.push(filters.profile)
  }
  if (filters.provider) {
    conditions.push('provider_id = ?')
    params.push(filters.provider)
  }
  if (filters.model) {
    conditions.push('model = ?')
    params.push(filters.model)
  }

  const sql = `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`

  return withUsageDb((db) => {
    const rows = db.prepare(sql).all(...params) as Array<
      Record<string, unknown>
    >
    return rows.map((r) => {
      const defaultAgent = dataSource === 'claude-code' ? 'cc-impl' : 'codex-impl'
      const defaultProvider = dataSource === 'claude-code' ? 'claude-code' : 'codex'
      return {
        requestId: String(r.session_id ?? ''),
        agentId: String(r.agent_id ?? defaultAgent),
        profile: String(r.profile ?? ''),
        providerId: String(r.provider_id ?? defaultProvider),
        providerName: String(r.provider_id ?? defaultProvider),
        model: String(r.model ?? 'unknown'),
        inputTokens: readNum((r.input_tokens ?? r.inputTokens) as number),
        outputTokens: readNum((r.output_tokens ?? r.outputTokens) as number),
        cacheReadTokens: readNum((r.cache_read_tokens ?? r.cacheReadTokens) as number),
        cacheCreationTokens: readNum((r.cache_creation_tokens ?? r.cacheCreationTokens) as number),
        statusCode: 200,
        latencyMs: 0,
        createdAt: readNum(r.created_at as number),
        dataSource,
        costMultiplier: '1',
      }
    })
  })
}

function applyDimensionFilters(
  filters: Omit<UsageFilters, 'range' | 'dataSource'>,
) {
  return (r: RawRecord) => {
    if (filters.agent && r.agentId !== filters.agent) return false
    if (filters.profile && r.profile !== filters.profile) return false
    if (filters.provider && r.providerId !== filters.provider) return false
    if (filters.model && r.model !== filters.model) return false
    return true
  }
}

let importerPromise: Promise<void> | null = null
let lastImporterRun = 0
const IMPORTER_MIN_INTERVAL_MS = 60_000

async function ensureSessionsImported(): Promise<void> {
  if (Date.now() - lastImporterRun < IMPORTER_MIN_INTERVAL_MS) return
  if (!importerPromise) {
    importerPromise = (async () => {
      try {
        await runSessionImporter()
      } catch (err) {
        console.warn('[usage-aggregator] session importer failed:', err)
      } finally {
        lastImporterRun = Date.now()
        importerPromise = null
      }
    })()
  }
  return importerPromise
}

async function loadRecords(filters: UsageFilters): Promise<RawRecord[]> {
  const { start, end } = filters.range

  // Background-import Claude/Codex sessions before querying them.
  if (filters.dataSource !== 'hermes') {
    await ensureSessionsImported()
  }

  if (filters.dataSource === 'all') {
    const hermes = await loadHermesRecords(start, end, filters)
    const claude = loadSessionRecords(start, end, filters, 'claude-code')
    const codex = loadSessionRecords(start, end, filters, 'codex')
    return [...hermes, ...claude, ...codex]
  }

  if (filters.dataSource === 'hermes') {
    return loadHermesRecords(start, end, filters)
  }

  return loadSessionRecords(start, end, filters, filters.dataSource)
}

function recordsToSummary(records: RawRecord[]): UsageSummary {
  let totalRequests = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheCreation = 0
  let totalCacheRead = 0
  let totalCost = 0

  for (const r of records) {
    totalRequests += 1
    totalInput += r.inputTokens
    totalOutput += r.outputTokens
    totalCacheCreation += r.cacheCreationTokens
    totalCacheRead += r.cacheReadTokens

    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    totalCost += Number(cost.totalCost) || 0
  }

  const realTotal = totalInput + totalOutput + totalCacheCreation + totalCacheRead
  const cacheable = totalInput + totalCacheCreation + totalCacheRead
  const cacheHitRate = cacheable > 0 ? totalCacheRead / cacheable : 0

  return {
    totalRequests,
    totalCost: formatCost(totalCost),
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheCreationTokens: totalCacheCreation,
    totalCacheReadTokens: totalCacheRead,
    realTotalTokens: realTotal,
    cacheHitRate,
  }
}

export async function getUsageSummary(
  filters: UsageFilters,
): Promise<UsageSummary> {
  const records = await loadRecords(filters)
  return recordsToSummary(records)
}

export async function getUsageByAgent(
  filters: UsageFilters,
): Promise<AgentUsageStats[]> {
  const records = await loadRecords(filters)
  const groups = new Map<string, AgentUsageStats>()

  for (const r of records) {
    const key = r.agentId
    const existing = groups.get(key)
    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    const costNum = Number(cost.totalCost) || 0

    if (!existing) {
      groups.set(key, {
        agentId: r.agentId,
        agentName: r.agentId,
        runtime: dataSourceToRuntime(r.dataSource),
        requestCount: 1,
        totalTokens:
          r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheCreationTokens,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheHitRate: 0,
        totalCost: formatCost(costNum),
        avgLatencyMs: r.latencyMs,
      })
    } else {
      existing.requestCount += 1
      existing.totalTokens +=
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheCreationTokens
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheReadTokens += r.cacheReadTokens
      existing.cacheCreationTokens += r.cacheCreationTokens
      existing.totalCost = formatCost(
        (Number(existing.totalCost) || 0) + costNum,
      )
      existing.avgLatencyMs = Math.round(
        (existing.avgLatencyMs * (existing.requestCount - 1) + r.latencyMs) /
          existing.requestCount,
      )
    }
  }

  for (const g of groups.values()) {
    const cacheable =
      g.inputTokens + g.cacheCreationTokens + g.cacheReadTokens
    g.cacheHitRate = cacheable > 0 ? g.cacheReadTokens / cacheable : 0
  }

  return Array.from(groups.values()).sort(
    (a, b) => Number(b.totalCost) - Number(a.totalCost),
  )
}

function dataSourceToRuntime(
  ds: UsageDataSource,
): AgentUsageStats['runtime'] {
  if (ds === 'claude-code') return 'claude-code'
  if (ds === 'codex') return 'codex'
  return 'hermes'
}

export async function getUsageByProfile(
  filters: UsageFilters,
): Promise<ProfileUsageStats[]> {
  const records = await loadRecords(filters)
  const groups = new Map<string, ProfileUsageStats>()

  for (const r of records) {
    const key = r.profile || 'default'
    const existing = groups.get(key)
    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    const costNum = Number(cost.totalCost) || 0

    if (!existing) {
      groups.set(key, {
        profile: key,
        requestCount: 1,
        totalTokens:
          r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheCreationTokens,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheHitRate: 0,
        totalCost: formatCost(costNum),
      })
    } else {
      existing.requestCount += 1
      existing.totalTokens +=
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheCreationTokens
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheReadTokens += r.cacheReadTokens
      existing.cacheCreationTokens += r.cacheCreationTokens
      existing.totalCost = formatCost(
        (Number(existing.totalCost) || 0) + costNum,
      )
    }
  }

  for (const g of groups.values()) {
    const cacheable =
      g.inputTokens + g.cacheCreationTokens + g.cacheReadTokens
    g.cacheHitRate = cacheable > 0 ? g.cacheReadTokens / cacheable : 0
  }

  return Array.from(groups.values()).sort(
    (a, b) => Number(b.totalCost) - Number(a.totalCost),
  )
}

export async function getUsageByModel(
  filters: UsageFilters,
): Promise<ModelUsageStats[]> {
  const records = await loadRecords(filters)
  const groups = new Map<string, ModelUsageStats>()

  for (const r of records) {
    const key = r.model
    const existing = groups.get(key)
    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    const costNum = Number(cost.totalCost) || 0

    if (!existing) {
      groups.set(key, {
        model: key,
        requestCount: 1,
        totalTokens:
          r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheCreationTokens,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheHitRate: 0,
        totalCost: formatCost(costNum),
        avgCostPerRequest: formatCost(costNum),
      })
    } else {
      existing.requestCount += 1
      existing.totalTokens +=
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheCreationTokens
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheReadTokens += r.cacheReadTokens
      existing.cacheCreationTokens += r.cacheCreationTokens
      existing.totalCost = formatCost(
        (Number(existing.totalCost) || 0) + costNum,
      )
      existing.avgCostPerRequest = formatCost(
        (Number(existing.totalCost) || 0) / existing.requestCount,
      )
    }
  }

  for (const g of groups.values()) {
    const cacheable =
      g.inputTokens + g.cacheCreationTokens + g.cacheReadTokens
    g.cacheHitRate = cacheable > 0 ? g.cacheReadTokens / cacheable : 0
  }

  return Array.from(groups.values()).sort(
    (a, b) => Number(b.totalCost) - Number(a.totalCost),
  )
}

export async function getUsageByProvider(
  filters: UsageFilters,
): Promise<ProviderUsageStats[]> {
  const records = await loadRecords(filters)
  const groups = new Map<string, ProviderUsageStats>()

  for (const r of records) {
    const key = r.providerId
    const existing = groups.get(key)
    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    const costNum = Number(cost.totalCost) || 0

    if (!existing) {
      groups.set(key, {
        providerId: key,
        providerName: r.providerName || key,
        requestCount: 1,
        totalTokens:
          r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheCreationTokens,
        totalCost: formatCost(costNum),
        successRate: r.statusCode >= 200 && r.statusCode < 300 ? 1 : 0,
        avgLatencyMs: r.latencyMs,
      })
    } else {
      existing.requestCount += 1
      existing.totalTokens +=
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheCreationTokens
      existing.totalCost = formatCost(
        (Number(existing.totalCost) || 0) + costNum,
      )
      if (r.statusCode >= 200 && r.statusCode < 300) {
        existing.successRate =
          (existing.successRate * (existing.requestCount - 1) + 1) /
          existing.requestCount
      } else {
        existing.successRate =
          (existing.successRate * (existing.requestCount - 1)) /
          existing.requestCount
      }
      existing.avgLatencyMs = Math.round(
        (existing.avgLatencyMs * (existing.requestCount - 1) + r.latencyMs) /
          existing.requestCount,
      )
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => Number(b.totalCost) - Number(a.totalCost),
  )
}

export async function getUsageTrends(
  filters: UsageFilters,
): Promise<DailyStats[]> {
  const records = await loadRecords(filters)
  const groups = new Map<string, DailyStats>()

  for (const r of records) {
    const date = new Date(r.createdAt).toISOString().slice(0, 10)
    const existing = groups.get(date)
    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    const costNum = Number(cost.totalCost) || 0

    if (!existing) {
      groups.set(date, {
        date,
        requestCount: 1,
        totalTokens:
          r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheCreationTokens,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        totalCost: formatCost(costNum),
      })
    } else {
      existing.requestCount += 1
      existing.totalTokens +=
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheCreationTokens
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheReadTokens += r.cacheReadTokens
      existing.cacheCreationTokens += r.cacheCreationTokens
      existing.totalCost = formatCost(
        (Number(existing.totalCost) || 0) + costNum,
      )
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  )
}

export async function getRequestLogs(
  filters: UsageFilters,
  page: number,
  pageSize: number,
): Promise<{ data: RequestLogEntry[]; total: number }> {
  const records = await loadRecords(filters)
  const total = records.length
  const pageRecords = records
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(page * pageSize, (page + 1) * pageSize)

  const data: RequestLogEntry[] = pageRecords.map((r) => {
    const cost = calculateNormalizedCost({
      providerId: r.providerId,
      modelId: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      multiplier: r.costMultiplier,
    })
    return {
      requestId: r.requestId,
      agentId: r.agentId,
      profile: r.profile,
      providerId: r.providerId,
      providerName: r.providerName,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      totalCostUsd: cost.totalCost,
      statusCode: r.statusCode,
      latencyMs: r.latencyMs,
      createdAt: r.createdAt,
      dataSource: r.dataSource,
    }
  })

  return { data, total }
}

export async function getSessionLogs(
  filters: UsageFilters,
  page: number,
  pageSize: number,
): Promise<{ data: SessionLogEntry[]; total: number }> {
  const { start, end } = filters.range
  const ds = filters.dataSource === 'all' ? 'claude-code' : filters.dataSource
  if (ds === 'hermes') return { data: [], total: 0 }

  const table = ds === 'claude-code' ? 'claude_code_sessions' : 'codex_sessions'
  const params: Array<string | number> = [start, end]
  const conditions = ['created_at >= ? AND created_at <= ?']

  if (filters.agent) {
    conditions.push('agent_id = ?')
    params.push(filters.agent)
  }
  if (filters.profile) {
    conditions.push('profile = ?')
    params.push(filters.profile)
  }
  if (filters.model) {
    conditions.push('model = ?')
    params.push(filters.model)
  }

  const sql = `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${page * pageSize}`
  const countSql = `SELECT COUNT(*) as c FROM ${table} WHERE ${conditions.join(' AND ')}`

  return withUsageDb((db) => {
    const rows = db.prepare(sql).all(...params) as Array<
      Record<string, unknown>
    >
    const countRow = db.prepare(countSql).all(...params)[0] as
      | { c: number }
      | undefined
    const total = countRow?.c ?? 0

    const data: SessionLogEntry[] = rows.map((r) => {
      const defaultAgent = ds === 'claude-code' ? 'cc-impl' : 'codex-impl'
      const defaultProvider = ds === 'claude-code' ? 'claude-code' : 'codex'
      return {
        sessionId: String(r.session_id ?? ''),
        agentId: String(r.agent_id ?? defaultAgent),
        profile: String(r.profile ?? ''),
        providerId: String(r.provider_id ?? defaultProvider),
        model: String(r.model ?? 'unknown'),
        title: r.title ? String(r.title) : undefined,
        inputTokens: readNum(r.input_tokens as number),
        outputTokens: readNum(r.output_tokens as number),
        cacheReadTokens: readNum(r.cache_read_tokens as number),
        cacheCreationTokens: readNum(r.cache_creation_tokens as number),
        totalCostUsd: String(r.total_cost_usd ?? '0'),
        createdAt: readNum(r.created_at as number),
        lastActiveAt: r.last_active_at ? readNum(r.last_active_at as number) : undefined,
        dataSource: ds,
      }
    })

    return { data, total }
  })
}
