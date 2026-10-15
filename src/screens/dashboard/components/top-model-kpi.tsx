import { useMemo } from 'react'
import { formatTokenCount } from '@/lib/format'
import {
  canonicalModelAnalyticsKey,
  preferModelDisplayId,
} from '@/lib/model-analytics'
import { formatModelName } from '@/screens/dashboard/lib/formatters'
import type { DashboardOverview } from '@/server/dashboard-aggregator'
import {
  useUsageByModel,
  useUsageSummary,
  type UsageFilters,
} from '../hooks/use-usage-data'

function formatCount(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

type MergedTop = {
  model: string
  provider: string
  totalTokens: number
  requestCount: number
}

function mergeUsageByModel(
  rows: Array<{
    model: string
    provider: string
    totalTokens: number
    requestCount: number
  }>,
): MergedTop | null {
  const map = new Map<string, MergedTop>()
  for (const row of rows) {
    const key = canonicalModelAnalyticsKey(row.model)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...row })
      continue
    }
    map.set(key, {
      model: preferModelDisplayId(prev.model, row.model),
      provider: row.provider || prev.provider,
      totalTokens: prev.totalTokens + row.totalTokens,
      requestCount: prev.requestCount + row.requestCount,
    })
  }
  const sorted = [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  return sorted[0] ?? null
}

/**
 * Hero slot: highest-usage model in the selected window (usage API),
 * with overview analytics as fallback.
 */
export function TopModelKpi({
  filters,
  analytics,
}: {
  filters: UsageFilters
  analytics: DashboardOverview['analytics']
}) {
  const { data: byModel, isLoading } = useUsageByModel(filters)
  const { data: summary } = useUsageSummary(filters)

  const top = useMemo((): MergedTop | null => {
    if (byModel?.length) {
      return mergeUsageByModel(byModel)
    }
    const fallback = analytics?.topModels?.[0]
    if (!fallback) return null
    return {
      model: fallback.id,
      provider: '',
      totalTokens: fallback.tokens,
      requestCount: fallback.calls,
    }
  }, [analytics?.topModels, byModel])

  const totalRequests =
    summary?.totalRequests ?? summary?.requestCount ?? 0
  const totalTokensWindow =
    summary?.realTotalTokens ?? summary?.totalTokens ?? 0
  // Ranked by tokens — show token share (not request share). A model can
  // be ~99% of tokens with far fewer billing rows (heavy cache reads).
  const tokenShare =
    top && totalTokensWindow > 0
      ? Math.round((top.totalTokens / totalTokensWindow) * 100)
      : null
  const requestShare =
    top && totalRequests > 0
      ? Math.round((top.requestCount / totalRequests) * 100)
      : null

  const hasData = !!top
  const tone = hasData ? 'var(--theme-accent)' : 'var(--theme-muted)'
  const windowLabel = `${filters.range} / ${filters.dataSource ?? 'all'}`

  if (isLoading && !top) {
    return (
      <div
        className="h-[118px] animate-pulse rounded-xl border"
        style={{ borderColor: 'var(--theme-border)' }}
      />
    )
  }

  return (
    <div
      className="relative flex flex-col gap-2 overflow-hidden rounded-xl border px-4 pb-3 pt-4"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--theme-card) 96%, transparent), color-mix(in srgb, var(--theme-card) 92%, transparent))',
        borderColor: 'var(--theme-border)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background: `linear-gradient(90deg, ${tone}, ${tone}55, transparent)`,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-25 blur-2xl"
        style={{ background: tone }}
      />

      <div className="flex items-center justify-between">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--theme-muted)' }}
        >
          Top model
        </span>
        <span
          className="font-mono text-[9px] uppercase tracking-[0.15em]"
          style={{ color: 'var(--theme-muted)' }}
        >
          {windowLabel}
        </span>
      </div>

      <div className="flex items-end justify-between gap-2">
        <span
          className="font-mono text-2xl font-bold leading-none tracking-tight"
          style={{ color: 'var(--theme-text)' }}
          title={top?.model}
        >
          {top ? formatModelName(top.model) : '—'}
        </span>
        {tokenShare !== null ? (
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]"
            style={{
              background:
                'color-mix(in srgb, var(--theme-accent) 12%, transparent)',
              color: 'var(--theme-accent)',
            }}
            title={
              requestShare !== null
                ? `${tokenShare}% of window tokens · ${requestShare}% of billing rows (${top?.requestCount ?? 0} of ${totalRequests} requests).`
                : `${tokenShare}% of window tokens.`
            }
          >
            {tokenShare}% tok
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span
          className="truncate font-mono uppercase tracking-[0.12em]"
          style={{ color: 'var(--theme-muted)' }}
        >
          {top?.provider ? `${top.provider} · ` : ''}
          {top && totalRequests > 0
            ? `${formatCount(top.requestCount)} of ${formatCount(totalRequests)} req`
            : top
              ? `${formatCount(top.requestCount)} model req`
              : 'No usage yet'}
        </span>
        {top && top.totalTokens > 0 ? (
          <span
            className="font-mono uppercase tracking-[0.12em]"
            style={{ color: 'var(--theme-muted)' }}
          >
            {formatTokenCount(top.totalTokens)} tok
          </span>
        ) : null}
      </div>
    </div>
  )
}
