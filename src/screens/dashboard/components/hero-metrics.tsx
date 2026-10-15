import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { DashboardOverview } from '@/server/dashboard-aggregator'
import { formatTokenCount, formatUsd } from '@/lib/format'
import {
  useUsageSummary,
  type UsageFilters,
} from '../hooks/use-usage-data'

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCount(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null
  const delta = ((current - previous) / previous) * 100
  if (!Number.isFinite(delta)) return null
  return delta
}

/**
 * Sparkline rendered inline as SVG. Native dashboard uses recharts
 * for big charts but the hero band wants tiny, fast, dependency-free
 * sparks that can sit inside metric tiles.
 */
function Spark({
  values,
  tone,
  height = 28,
  width = 96,
}: {
  values: Array<number>
  tone: string
  height?: number
  width?: number
}) {
  if (values.length === 0) {
    return <div style={{ width, height }} />
  }
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const stepX = width / Math.max(values.length - 1, 1)
  const points = values
    .map((v, i) => {
      const x = i * stepX
      const y = height - ((v - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const areaPoints = `0,${height} ${points} ${width},${height}`
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient
          id={`spark-grad-${tone.replace('#', '')}`}
          x1="0"
          x2="0"
          y1="0"
          y2="1"
        >
          <stop offset="0%" stopColor={tone} stopOpacity={0.35} />
          <stop offset="100%" stopColor={tone} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon
        points={areaPoints}
        fill={`url(#spark-grad-${tone.replace('#', '')})`}
      />
      <polyline
        points={points}
        stroke={tone}
        strokeWidth={1.5}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

type HeroTileProps = {
  label: string
  value: string
  sub?: string
  subLines?: Array<string>
  delta?: number | null
  spark?: Array<number>
  tone: string
  icon: string
}

function HeroTile({
  label,
  value,
  sub,
  subLines,
  delta,
  spark,
  tone,
  icon,
}: HeroTileProps) {
  const deltaText = (() => {
    if (delta === null || delta === undefined) return null
    const sign = delta > 0 ? '+' : ''
    const tone =
      Math.abs(delta) < 1
        ? 'var(--theme-muted)'
        : delta > 0
          ? 'var(--theme-success)'
          : 'var(--theme-warning)'
    return { text: `${sign}${delta.toFixed(0)}%`, tone }
  })()
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
          {label}
        </span>
        <span
          className="flex size-7 items-center justify-center rounded-md text-sm"
          style={{
            background: `color-mix(in srgb, ${tone} 14%, transparent)`,
            color: tone,
          }}
          aria-hidden
        >
          {icon}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span
          className="font-mono text-3xl font-bold tabular-nums leading-none tracking-tight"
          style={{ color: 'var(--theme-text)' }}
        >
          {value}
        </span>
        {spark ? <Spark values={spark} tone={tone} /> : null}
      </div>
      <div className="flex items-end justify-between gap-2 text-[10px]">
        {subLines && subLines.length > 0 ? (
          <div className="min-w-0 space-y-0.5">
            {subLines.map((line) => (
              <div
                key={line}
                className="truncate font-mono tracking-[0.06em]"
                style={{ color: 'var(--theme-muted)' }}
              >
                {line}
              </div>
            ))}
          </div>
        ) : sub ? (
          <span
            className="truncate font-mono uppercase tracking-[0.12em]"
            style={{ color: 'var(--theme-muted)' }}
          >
            {sub}
          </span>
        ) : (
          <span />
        )}
        {deltaText ? (
          <span
            className="rounded px-1.5 py-0.5 font-mono uppercase tracking-[0.1em]"
            style={{
              background: `color-mix(in srgb, ${deltaText.tone} 12%, transparent)`,
              color: deltaText.tone,
            }}
          >
            {deltaText.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Hero metrics band — the 10-second read across the top of the
 * dashboard. Replaces the legacy 4 small tiles with bigger numbers,
 * inline sparklines, and period-over-period deltas for sessions and
 * tokens. Pulls real values from the analytics aggregator and usage
 * summary (tokens, sessions, estimated cost). When analytics is
 * unavailable, falls back to session-derived totals.
 */
export function HeroMetrics({
  analytics,
  fallback,
  usageFilters,
  extraTile,
}: {
  analytics: DashboardOverview['analytics']
  fallback: {
    sessions: number
    messages: number
    toolCalls: number
    tokens: number
  }
  /** Same window as Usage summary / analytics chart filters. */
  usageFilters?: UsageFilters
  /**
   * Optional 4th tile slot (e.g. top model KPI).
   */
  extraTile?: ReactNode
}) {
  const { data: usageSummary } = useUsageSummary(
    usageFilters ?? { range: '30d', dataSource: 'all' },
  )
  // Decide source: analytics is canonical when it has any usage; otherwise fall back.
  const useAnalytics = !!analytics && analytics.source === 'analytics'

  const dailyTokens = useAnalytics
    ? analytics!.daily.map((d) => d.inputTokens + d.outputTokens)
    : []
  const dailySessions = useAnalytics
    ? analytics!.daily.map((d) => d.sessions)
    : []
  // Period-over-period deltas: split daily into the latter half vs the prior half.
  const splitSum = (arr: Array<number>): [number, number] => {
    if (arr.length < 2) return [arr.reduce((a, b) => a + b, 0), 0]
    const mid = Math.floor(arr.length / 2)
    const prev = arr.slice(0, mid).reduce((a, b) => a + b, 0)
    const curr = arr.slice(mid).reduce((a, b) => a + b, 0)
    return [curr, prev]
  }

  const [sessCurr, sessPrev] = splitSum(dailySessions)
  const [tokCurr, tokPrev] = splitSum(dailyTokens)

  const analyticsTokensTotal = useAnalytics
    ? analytics!.totalTokens
    : fallback.tokens
  const usageRealTotal =
    usageSummary?.realTotalTokens ?? usageSummary?.totalTokens ?? 0
  const tokensTotal =
    usageRealTotal > 0 ? usageRealTotal : analyticsTokensTotal
  const cacheHitPct = usageSummary
    ? (usageSummary.cacheHitRate ?? 0) * 100
    : null
  const usageInput = usageSummary?.totalInputTokens ?? 0
  const usageOutput = usageSummary?.totalOutputTokens ?? 0
  const usageCacheRead = usageSummary?.totalCacheReadTokens ?? 0
  const usageCacheWrite =
    usageSummary?.totalCacheCreationTokens ??
    usageSummary?.totalCacheWriteTokens ??
    0

  const tokenSubLines = ((): Array<string> | undefined => {
    if (usageRealTotal > 0 && (usageInput > 0 || usageOutput > 0)) {
      const lines = [
        `In ${formatTokenCount(usageInput)} / Out ${formatTokenCount(usageOutput)}`,
      ]
      if (cacheHitPct !== null) {
        lines.push(
          `${cacheHitPct.toFixed(1)}% cache · Rd ${formatTokenCount(usageCacheRead)} / Wr ${formatTokenCount(usageCacheWrite)}`,
        )
      }
      return lines
    }
    if (useAnalytics && analytics!.cacheReadTokens > 0) {
      return [
        `${formatTokens(analytics!.cacheReadTokens)} cached reads`,
        `In ${formatTokens(analytics!.inputTokens)} / Out ${formatTokens(analytics!.outputTokens)}`,
      ]
    }
    return undefined
  })()

  const sessionsTotal = useAnalytics
    ? analytics!.totalSessions
    : fallback.sessions
  const usageRequests =
    usageSummary?.totalRequests ?? usageSummary?.requestCount ?? 0
  const estCostUsd =
    usageSummary?.totalCost ??
    usageSummary?.estimatedCost ??
    (useAnalytics && analytics!.estimatedCostUsd != null
      ? String(analytics!.estimatedCostUsd)
      : '0')

  const window = useAnalytics ? `${analytics!.windowDays}d` : 'all time'
  const costSubLines = ((): Array<string> | undefined => {
    const lines: Array<string> = []
    if (usageRequests > 0) {
      lines.push(`${formatCount(usageRequests)} requests`)
    }
    if (usageFilters) {
      lines.push(
        `${usageFilters.range} / ${usageFilters.dataSource ?? 'all'}`,
      )
    } else {
      lines.push(window)
    }
    return lines.length > 0 ? lines : undefined
  })()

  const tiles: Array<HeroTileProps> = useMemo(
    () => [
      {
        label: 'Sessions',
        value: formatCount(sessionsTotal),
        sub: window,
        delta: useAnalytics ? deltaPct(sessCurr, sessPrev) : null,
        spark: useAnalytics ? dailySessions : undefined,
        tone: 'var(--theme-accent)',
        icon: '💬',
      },
      {
        label: 'Tokens',
        value: formatTokens(tokensTotal),
        sub: tokenSubLines ? undefined : useAnalytics ? undefined : 'Hermes ledger',
        subLines: tokenSubLines,
        delta: useAnalytics ? deltaPct(tokCurr, tokPrev) : null,
        spark: useAnalytics ? dailyTokens : undefined,
        tone: 'var(--theme-accent-secondary)',
        icon: '⚡',
      },
      {
        label: 'Est. cost',
        value: formatUsd(estCostUsd),
        subLines: costSubLines,
        delta: null,
        tone: 'var(--theme-success)',
        icon: '💵',
      },
    ],
    [
      analytics,
      costSubLines,
      dailySessions,
      dailyTokens,
      estCostUsd,
      sessCurr,
      sessPrev,
      sessionsTotal,
      tokCurr,
      tokPrev,
      tokenSubLines,
      tokensTotal,
      useAnalytics,
      usageFilters,
      window,
    ],
  )

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <HeroTile key={t.label} {...t} />
      ))}
      {extraTile}
    </div>
  )
}
