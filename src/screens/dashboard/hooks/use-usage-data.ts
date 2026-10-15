import { useQuery } from '@tanstack/react-query'

export type UsageRange = '1d' | '7d' | '30d'
export type UsageDataSource = 'all' | 'hermes' | 'claude-code' | 'codex'

type UsageSummary = {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCacheCreationTokens: number
  totalTokens: number
  realTotalTokens: number
  estimatedCost: string
  totalCost: string
  cacheHitRate: number
  requestCount: number
  totalRequests: number
}

type UsageByModel = Array<{
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}>

type UsageByProvider = Array<{
  provider: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}>

type UsageByAgent = Array<{
  agentId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}>

type UsageByProfile = Array<{
  profile: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}>

type DailyTrend = {
  date: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}

export interface UsageFilters {
  range: UsageRange
  dataSource?: UsageDataSource
  agent?: string
  profile?: string
  provider?: string
  model?: string
}

function buildUsageUrl(base: string, filters: UsageFilters): string {
  const params = new URLSearchParams()
  params.set('range', filters.range)
  if (filters.dataSource && filters.dataSource !== 'all') {
    params.set('dataSource', filters.dataSource)
  }
  if (filters.agent) params.set('agent', filters.agent)
  if (filters.profile) params.set('profile', filters.profile)
  if (filters.provider) params.set('provider', filters.provider)
  if (filters.model) params.set('model', filters.model)
  return `${base}?${params.toString()}`
}

export function usageFiltersToQueryKey(filters: UsageFilters): string[] {
  return [
    filters.range,
    filters.dataSource ?? 'all',
    filters.agent ?? '',
    filters.profile ?? '',
    filters.provider ?? '',
    filters.model ?? '',
  ]
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`usage fetch failed: ${res.status}`)
  const payload = (await res.json()) as { ok: boolean; data: T; error?: string }
  if (!payload.ok) throw new Error(payload.error ?? 'unknown error')
  return payload.data
}

export function useUsageSummary(filters: UsageFilters) {
  return useQuery<UsageSummary>({
    queryKey: ['usage', 'summary', ...usageFiltersToQueryKey(filters)],
    queryFn: () => fetchJson<UsageSummary>(buildUsageUrl('/api/usage/summary', filters)),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useUsageByModel(filters: UsageFilters) {
  return useQuery<UsageByModel>({
    queryKey: ['usage', 'by-model', ...usageFiltersToQueryKey(filters)],
    queryFn: () => fetchJson<UsageByModel>(buildUsageUrl('/api/usage/by-model', filters)),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useUsageByProvider(filters: UsageFilters) {
  return useQuery<UsageByProvider>({
    queryKey: ['usage', 'by-provider', ...usageFiltersToQueryKey(filters)],
    queryFn: () =>
      fetchJson<UsageByProvider>(buildUsageUrl('/api/usage/by-provider', filters)),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useUsageByAgent(filters: UsageFilters) {
  return useQuery<UsageByAgent>({
    queryKey: ['usage', 'by-agent', ...usageFiltersToQueryKey(filters)],
    queryFn: () => fetchJson<UsageByAgent>(buildUsageUrl('/api/usage/by-agent', filters)),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useUsageByProfile(filters: UsageFilters) {
  return useQuery<UsageByProfile>({
    queryKey: ['usage', 'by-profile', ...usageFiltersToQueryKey(filters)],
    queryFn: () =>
      fetchJson<UsageByProfile>(buildUsageUrl('/api/usage/by-profile', filters)),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useUsageTrends(filters: UsageFilters) {
  return useQuery<DailyTrend[]>({
    queryKey: ['usage', 'trends', ...usageFiltersToQueryKey(filters)],
    queryFn: () => fetchJson<DailyTrend[]>(buildUsageUrl('/api/usage/trends', filters)),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export type ModelPricingEntry = {
  modelId: string
  inputPrice?: string
  outputPrice?: string
  cacheReadPrice?: string
  cacheWritePrice?: string
  inputTokenMode?: 'cache-inclusive' | 'fresh-input'
  outputTokenMode?: 'cache-inclusive' | 'fresh-input'
  multiplier?: string
  provider?: string
}

export type PricingConfig = {
  defaultMultiplier: string
  models: Record<string, ModelPricingEntry>
  updatedAt: number
}

export function useModelPricing() {
  return useQuery<PricingConfig>({
    queryKey: ['usage', 'pricing'],
    queryFn: async () => {
      const res = await fetch('/api/usage/pricing')
      if (!res.ok) throw new Error(`pricing fetch failed: ${res.status}`)
      return (await res.json()) as PricingConfig
    },
    staleTime: 60_000,
  })
}
