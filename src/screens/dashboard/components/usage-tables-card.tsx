import { useState } from 'react'
import {
  useUsageByAgent,
  useUsageByProfile,
  useUsageByModel,
  useUsageByProvider,
  type UsageFilters,
} from '../hooks/use-usage-data'
import { formatTokenCount, formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'

type Tab = 'agent' | 'profile' | 'model' | 'provider'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'agent', label: 'Agent' },
  { key: 'profile', label: 'Profile' },
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
]

function SectionTabs({
  active,
  onChange,
}: {
  active: Tab
  onChange: (tab: Tab) => void
}) {
  return (
    <div
      className="inline-flex items-center overflow-hidden rounded border"
      style={{ borderColor: 'var(--theme-border)' }}
      role="tablist"
      aria-label="Usage dimension"
    >
      {TABS.map((tab) => {
        const selected = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.key)}
            className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
            style={{
              background: selected
                ? 'color-mix(in srgb, var(--theme-accent) 18%, transparent)'
                : 'transparent',
              color: selected ? 'var(--theme-accent)' : 'var(--theme-muted)',
              borderRight:
                tab.key !== TABS[TABS.length - 1].key
                  ? '1px solid var(--theme-border)'
                  : 'none',
            }}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

type Row = {
  id: string
  provider?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCost: string
  requestCount: number
}

function SectionTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <div
        className="flex h-24 items-center justify-center rounded border border-dashed text-[11px]"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
      >
        No usage records in this window.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr
            className="text-left"
            style={{ color: 'var(--theme-muted)' }}
          >
            <th className="pb-2 font-medium uppercase tracking-wider">Name</th>
            <th className="pb-2 font-medium uppercase tracking-wider text-right">Tokens</th>
            <th className="pb-2 font-medium uppercase tracking-wider text-right">Input</th>
            <th className="pb-2 font-medium uppercase tracking-wider text-right">Output</th>
            <th className="pb-2 font-medium uppercase tracking-wider text-right">Cache</th>
            <th className="pb-2 font-medium uppercase tracking-wider text-right">Cost</th>
            <th className="pb-2 font-medium uppercase tracking-wider text-right">Reqs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-t transition-colors hover:bg-[var(--theme-card)]/60"
              style={{ borderColor: 'var(--theme-border)' }}
            >
              <td className="py-2" style={{ color: 'var(--theme-text)' }}>
                <div className="font-medium">{row.id}</div>
                {row.provider ? (
                  <div className="text-[10px]" style={{ color: 'var(--theme-muted)' }}>
                    {row.provider}
                  </div>
                ) : null}
              </td>
              <td
                className="py-2 text-right tabular-nums"
                style={{ color: 'var(--theme-text)' }}
              >
                {formatTokenCount(row.totalTokens)}
              </td>
              <td
                className="py-2 text-right tabular-nums"
                style={{ color: 'var(--theme-muted)' }}
              >
                {formatTokenCount(row.inputTokens)}
              </td>
              <td
                className="py-2 text-right tabular-nums"
                style={{ color: 'var(--theme-muted)' }}
              >
                {formatTokenCount(row.outputTokens)}
              </td>
              <td
                className="py-2 text-right tabular-nums"
                style={{ color: 'var(--theme-muted)' }}
              >
                {formatTokenCount(row.cacheReadTokens + row.cacheWriteTokens)}
              </td>
              <td
                className="py-2 text-right tabular-nums"
                style={{ color: 'var(--theme-text)' }}
              >
                {formatUsd(row.estimatedCost)}
              </td>
              <td
                className="py-2 text-right tabular-nums"
                style={{ color: 'var(--theme-muted)' }}
              >
                {row.requestCount.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function UsageTablesCard({
  className,
  filters,
}: {
  className?: string
  filters: UsageFilters
}) {
  const [tab, setTab] = useState<Tab>('agent')
  const byAgent = useUsageByAgent(filters)
  const byProfile = useUsageByProfile(filters)
  const byModel = useUsageByModel(filters)
  const byProvider = useUsageByProvider(filters)

  const rows: Row[] =
    tab === 'agent'
      ? (byAgent.data ?? []).map((r) => ({
          id: r.agentId,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          totalTokens: r.totalTokens,
          estimatedCost: r.estimatedCost,
          requestCount: r.requestCount,
        }))
      : tab === 'profile'
        ? (byProfile.data ?? []).map((r) => ({
            id: r.profile,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheWriteTokens: r.cacheWriteTokens,
            totalTokens: r.totalTokens,
            estimatedCost: r.estimatedCost,
            requestCount: r.requestCount,
          }))
        : tab === 'model'
          ? (byModel.data ?? []).map((r) => ({
              id: r.model,
              provider: r.provider,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cacheReadTokens: r.cacheReadTokens,
              cacheWriteTokens: r.cacheWriteTokens,
              totalTokens: r.totalTokens,
              estimatedCost: r.estimatedCost,
              requestCount: r.requestCount,
            }))
          : (byProvider.data ?? []).map((r) => ({
              id: r.provider,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              cacheReadTokens: r.cacheReadTokens,
              cacheWriteTokens: r.cacheWriteTokens,
              totalTokens: r.totalTokens,
              estimatedCost: r.estimatedCost,
              requestCount: r.requestCount,
            }))

  return (
    <div
      className={cn('rounded-2xl border p-4', className)}
      style={{ borderColor: 'var(--theme-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
          Usage breakdown
        </div>
        <SectionTabs active={tab} onChange={setTab} />
      </div>
      <div className="mt-4">
        <SectionTable rows={rows} />
      </div>
    </div>
  )
}
