/**
 * Shared types for the workspace usage/cost dashboard.
 *
 * These types mirror the cc-switch surface but are scoped to the
 * workspace data model: gateway analytics for Hermes agents plus
 * session-importer estimates for Claude Code / Codex.
 */

export type UsageRange =
  | { kind: '1d'; start: number; end: number }
  | { kind: '7d'; start: number; end: number }
  | { kind: '30d'; start: number; end: number }
  | { kind: 'custom'; start: number; end: number }

export function buildUsageRange(kind: '1d' | '7d' | '30d' | 'custom', custom?: { start: number; end: number }): UsageRange {
  const now = Date.now()
  const end = now
  switch (kind) {
    case '1d':
      return { kind: '1d', start: now - 24 * 60 * 60 * 1000, end }
    case '7d':
      return { kind: '7d', start: now - 7 * 24 * 60 * 60 * 1000, end }
    case '30d':
      return { kind: '30d', start: now - 30 * 24 * 60 * 60 * 1000, end }
    case 'custom':
      return { kind: 'custom', start: custom?.start ?? now - 24 * 60 * 60 * 1000, end: custom?.end ?? now }
  }
}

export function rangeToParams(range: UsageRange): {
  start: number
  end: number
  windowDays: number
} {
  return {
    start: range.start,
    end: range.end,
    windowDays: Math.max(
      1,
      Math.ceil((range.end - range.start) / (24 * 60 * 60 * 1000)),
    ),
  }
}

export type UsageDataSource = 'all' | 'hermes' | 'claude-code' | 'codex'

export interface UsageFilters {
  range: UsageRange
  agent?: string
  profile?: string
  provider?: string
  model?: string
  dataSource: UsageDataSource
}

export interface UsageSummary {
  totalRequests: number
  totalCost: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  realTotalTokens: number
  cacheHitRate: number
}

export interface AgentUsageStats {
  agentId: string
  agentName: string
  runtime: 'hermes' | 'claude-code' | 'codex' | 'deepseek-harness' | 'opencode' | 'unknown'
  requestCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
  totalCost: string
  avgLatencyMs: number
}

export interface ProfileUsageStats {
  profile: string
  requestCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
  totalCost: string
}

export interface ModelUsageStats {
  model: string
  requestCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
  totalCost: string
  avgCostPerRequest: string
}

export interface ProviderUsageStats {
  providerId: string
  providerName: string
  requestCount: number
  totalTokens: number
  totalCost: string
  successRate: number
  avgLatencyMs: number
}

export interface DailyStats {
  date: string
  requestCount: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCost: string
}

export interface RequestLogEntry {
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
  totalCostUsd: string
  statusCode: number
  latencyMs: number
  createdAt: number
  dataSource: UsageDataSource
}

export interface SessionLogEntry {
  sessionId: string
  agentId: string
  profile: string
  providerId: string
  model: string
  title?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: string
  createdAt: number
  lastActiveAt?: number
  dataSource: Exclude<UsageDataSource, 'all' | 'hermes'>
}

export interface ModelPricingEntry {
  modelId: string
  displayName?: string
  inputCostPerMillion: string
  outputCostPerMillion: string
  cacheReadCostPerMillion?: string
  cacheCreationCostPerMillion?: string
  inputTokenMode?: 'cache-inclusive' | 'fresh-input'
  multiplier?: string
  updatedAt: number
}

export interface PricingConfig {
  defaultMultiplier: string
  models: Record<string, ModelPricingEntry>
  updatedAt: number
}
