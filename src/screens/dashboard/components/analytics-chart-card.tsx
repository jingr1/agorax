import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { HugeiconsIcon } from '@hugeicons/react'
import { ChartLineData01Icon, CancelIcon } from '@hugeicons/core-free-icons'
import type { DashboardOverview } from '@/server/dashboard-aggregator'
import { formatModelName } from '@/screens/dashboard/lib/formatters'
import {
  useUsageTrends,
  useUsageByModel,
  type UsageFilters,
  type UsageDataSource,
  type UsageRange,
} from '../hooks/use-usage-data'

export type AnalyticsPeriod = 1 | 7 | 30

const PERIODS: Array<AnalyticsPeriod> = [1, 7, 30]

const DATA_SOURCE_OPTIONS: Array<{ value: UsageDataSource; label: string }> = [
  { value: 'all', label: 'All runtimes' },
  { value: 'hermes', label: 'Hermes gateway' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
]

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(usd: number): string {
  if (!usd || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString()}`
}

function shortDay(day: string): string {
  const ts = Date.parse(day)
  if (!Number.isFinite(ts)) return day
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

type ChartDatum = {
  day: string
  label: string
  tokens: number
  input: number
  output: number
  cache: number
  reasoning: number
  sessions: number
  cost: number
}

/**
 * Analytics trend chart card — the daily token mix area plot, plus a
 * row of insight callouts the operator can scan in 2 seconds before
 * looking at the curve. The period selector at top-right swaps the
 * window between 7 / 14 / 30 days, persisted up to the parent so
 * Hero KPIs use the same window.
 */
export function AnalyticsChartCard({
  period,
  onPeriodChange,
  filters,
  onFiltersChange,
}: {
  period: AnalyticsPeriod
  onPeriodChange: (next: AnalyticsPeriod) => void
  filters: UsageFilters
  onFiltersChange: (filters: UsageFilters) => void
}) {
  const [showModal, setShowModal] = useState(false)

  const trendsQuery = useUsageTrends(filters)
  const byModelQuery = useUsageByModel(filters)
  const isLoading = trendsQuery.isLoading || byModelQuery.isLoading
  const trends = trendsQuery.data ?? []
  const topModels = byModelQuery.data ?? []

  const data: Array<ChartDatum> = useMemo(() => {
    return trends.map((d) => ({
      day: d.date,
      label: shortDay(d.date),
      tokens: d.totalTokens,
      input: d.inputTokens,
      output: d.outputTokens,
      cache: d.cacheReadTokens,
      reasoning: 0,
      sessions: d.requestCount,
      cost: Number(d.estimatedCost ?? 0),
    }))
  }, [trends])

  const totalTokens = useMemo(
    () => topModels.reduce((sum, m) => sum + m.totalTokens, 0),
    [topModels],
  )
  const totalCalls = useMemo(
    () => topModels.reduce((sum, m) => sum + m.requestCount, 0),
    [topModels],
  )
  const totalCost = useMemo(
    () => topModels.reduce((sum, m) => sum + Number(m.estimatedCost ?? 0), 0),
    [topModels],
  )
  const hasData = data.length > 0

  return (
    <>
      <div
        className="relative flex flex-col gap-3 overflow-hidden rounded-xl border p-4"
        style={{
          background:
            'linear-gradient(150deg, color-mix(in srgb, var(--theme-card) 96%, transparent), color-mix(in srgb, var(--theme-card) 90%, transparent))',
          borderColor: 'var(--theme-border)',
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full opacity-20 blur-3xl"
          style={{ background: 'var(--theme-accent)' }}
        />

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              icon={ChartLineData01Icon}
              size={16}
              strokeWidth={1.5}
              style={{ color: 'var(--theme-accent)' }}
            />
            <div>
              <h3
                className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: 'var(--theme-text)' }}
              >
                Usage trend · {period}d
              </h3>
              <p
                className="font-mono text-[10px] uppercase tracking-[0.1em]"
                style={{ color: 'var(--theme-muted)' }}
              >
                {formatTokens(totalTokens)} tokens ·{' '}
                {totalCalls.toLocaleString()} calls · {formatCost(totalCost)}
                {isLoading ? ' · refreshing…' : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <DataSourceSelect
              value={filters.dataSource ?? 'all'}
              onChange={(dataSource) =>
                onFiltersChange({ ...filters, dataSource })
              }
            />
            <PeriodSwitch
              value={period}
              onChange={(next) => {
                onPeriodChange(next)
                onFiltersChange({
                  ...filters,
                  range: String(next) as UsageRange,
                })
              }}
            />
            {hasData ? (
              <button
                type="button"
                onClick={() => setShowModal(true)}
                className="ml-1 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors hover:bg-[var(--theme-card)]/80"
                style={{
                  borderColor: 'var(--theme-border)',
                  color: 'var(--theme-muted)',
                }}
              >
                Expand →
              </button>
            ) : null}
          </div>
        </div>

        {hasData ? (
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 4, right: 4, left: -22, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="atok" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="var(--theme-accent)"
                      stopOpacity={0.45}
                    />
                    <stop
                      offset="100%"
                      stopColor="var(--theme-accent)"
                      stopOpacity={0}
                    />
                  </linearGradient>
                  <linearGradient id="acache" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="var(--theme-accent-secondary)"
                      stopOpacity={0.25}
                    />
                    <stop
                      offset="100%"
                      stopColor="var(--theme-accent-secondary)"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="2 4"
                  stroke="var(--theme-border)"
                  opacity={0.4}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: 'var(--theme-muted)' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'var(--theme-muted)' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  tickFormatter={(v: number) => formatTokens(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--theme-card)',
                    border: '1px solid var(--theme-border)',
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  labelStyle={{
                    color: 'var(--theme-muted)',
                    fontSize: 10,
                  }}
                  formatter={(value: number, name: string) => [
                    formatTokens(value),
                    name,
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="cache"
                  name="cache"
                  stroke="var(--theme-accent-secondary)"
                  fill="url(#acache)"
                  strokeWidth={1}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  name="tokens"
                  stroke="var(--theme-accent)"
                  fill="url(#atok)"
                  strokeWidth={1.6}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div
            className="flex h-[120px] items-center justify-center rounded-md border border-dashed text-[11px]"
            style={{
              borderColor: 'var(--theme-border)',
              color: 'var(--theme-muted)',
            }}
          >
            No analytics usage in the last {period}d.
          </div>
        )}

        {hasData ? (
          <div className="flex items-center gap-4 text-[10px]">
            <Legend tone="var(--theme-accent)" label="tokens (in+out)" />
            <Legend tone="var(--theme-accent-secondary)" label="cache reads" />
          </div>
        ) : null}
      </div>

      {showModal && hasData ? (
        <AnalyticsModal
          data={data}
          period={period}
          topModels={topModels}
          totalTokens={totalTokens}
          totalCalls={totalCalls}
          totalCost={totalCost}
          onClose={() => setShowModal(false)}
        />
      ) : null}
    </>
  )
}

function DataSourceSelect({
  value,
  onChange,
}: {
  value: UsageDataSource
  onChange: (value: UsageDataSource) => void
}) {
  return (
    <div
      className="inline-flex items-center overflow-hidden rounded border"
      style={{ borderColor: 'var(--theme-border)' }}
      aria-label="Data source"
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as UsageDataSource)}
        className="appearance-none bg-transparent px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--theme-muted)] outline-none"
        style={{ border: 'none' }}
      >
        {DATA_SOURCE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function PeriodSwitch({
  value,
  onChange,
}: {
  value: AnalyticsPeriod
  onChange: (next: AnalyticsPeriod) => void
}) {
  return (
    <div
      className="inline-flex items-center overflow-hidden rounded border"
      style={{ borderColor: 'var(--theme-border)' }}
      role="tablist"
      aria-label="Analytics period"
    >
      {PERIODS.map((p) => {
        const active = p === value
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(p)}
            className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
            style={{
              background: active
                ? 'color-mix(in srgb, var(--theme-accent) 18%, transparent)'
                : 'transparent',
              color: active ? 'var(--theme-accent)' : 'var(--theme-muted)',
              borderRight:
                p !== PERIODS[PERIODS.length - 1]
                  ? '1px solid var(--theme-border)'
                  : 'none',
            }}
          >
            {p}d
          </button>
        )
      })}
    </div>
  )
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span
      className="flex items-center gap-1.5"
      style={{ color: 'var(--theme-muted)' }}
    >
      <span
        className="size-2 rounded-full"
        style={{ background: tone }}
        aria-hidden
      />
      {label}
    </span>
  )
}

type UsageByModelRow = {
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}

function AnalyticsModal({
  data,
  period,
  topModels,
  totalTokens,
  totalCalls,
  totalCost,
  onClose,
}: {
  data: Array<ChartDatum>
  period: AnalyticsPeriod
  topModels: UsageByModelRow[] | undefined
  totalTokens: number
  totalCalls: number
  totalCost: number
  onClose: () => void
}) {
  const models = topModels ?? []
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 py-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-[var(--theme-card)]"
        style={{ borderColor: 'var(--theme-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'var(--theme-border)' }}
        >
          <div>
            <h2
              className="text-sm font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--theme-text)' }}
            >
              Usage trend · last {period}d
            </h2>
            <p
              className="font-mono text-[10px] uppercase tracking-[0.1em]"
              style={{ color: 'var(--theme-muted)' }}
            >
              {formatTokens(totalTokens)} tokens ·{' '}
              {totalCalls.toLocaleString()} calls · {formatCost(totalCost)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-[var(--theme-card)]/80"
          >
            <HugeiconsIcon
              icon={CancelIcon}
              size={18}
              strokeWidth={1.5}
              style={{ color: 'var(--theme-muted)' }}
            />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <h3
              className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em]"
              style={{ color: 'var(--theme-muted)' }}
            >
              Daily token mix
            </h3>
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data}
                  margin={{ top: 8, right: 8, left: -10, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="2 4"
                    stroke="var(--theme-border)"
                    opacity={0.4}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'var(--theme-muted)' }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={20}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--theme-muted)' }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                    tickFormatter={(v: number) => formatTokens(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--theme-card)',
                      border: '1px solid var(--theme-border)',
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                    formatter={(value: number, name: string) => [
                      formatTokens(value),
                      name,
                    ]}
                  />
                  <Bar
                    dataKey="input"
                    name="input"
                    stackId="t"
                    fill="var(--theme-accent)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="output"
                    name="output"
                    stackId="t"
                    fill="var(--theme-success)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="reasoning"
                    name="reasoning"
                    stackId="t"
                    fill="var(--theme-warning)"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[10px]">
              <Legend tone="var(--theme-accent)" label="input" />
              <Legend tone="var(--theme-success)" label="output" />
              <Legend tone="var(--theme-warning)" label="reasoning" />
            </div>
          </div>

          <div className="lg:col-span-4">
            <h3
              className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em]"
              style={{ color: 'var(--theme-muted)' }}
            >
              Models · ranked by tokens
            </h3>
            <div className="space-y-2">
              {models.map((m, i) => (
                <div
                  key={m.model}
                  className="rounded border px-3 py-2"
                  style={{ borderColor: 'var(--theme-border)' }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="font-mono text-[12px] font-semibold"
                      style={{ color: 'var(--theme-text)' }}
                    >
                      <span
                        className="mr-1.5 inline-block w-4 text-right tabular-nums"
                        style={{ color: 'var(--theme-muted)' }}
                      >
                        {i + 1}
                      </span>
                      {formatModelName(m.model)}
                    </span>
                    <span
                      className="font-mono text-[10px] tabular-nums"
                      style={{ color: 'var(--theme-muted)' }}
                    >
                      {formatTokens(m.totalTokens)}
                    </span>
                  </div>
                  <div
                    className="mt-1 truncate font-mono text-[10px]"
                    style={{ color: 'var(--theme-muted)' }}
                    title={m.model}
                  >
                    {m.model}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[10px]">
                    <span style={{ color: 'var(--theme-muted)' }}>
                      sessions{' '}
                      <span style={{ color: 'var(--theme-text)' }}>
                        {m.requestCount.toLocaleString()}
                      </span>
                    </span>
                    <span style={{ color: 'var(--theme-muted)' }}>
                      cost{' '}
                      <span style={{ color: 'var(--theme-text)' }}>
                        {formatCost(Number(m.estimatedCost ?? 0))}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
