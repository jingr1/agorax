import { cn } from '@/lib/utils'
import type { OperationsAgent } from '../hooks/use-operations'

export type TeamOverviewFilter =
  | 'all'
  | 'active'
  | 'idle'
  | 'offline'
  | 'blocked'
  | 'error'
  | 'needsSetup'

type TeamOverviewProps = {
  agents: OperationsAgent[]
  filter: TeamOverviewFilter
  onFilterChange: (filter: TeamOverviewFilter) => void
}

function StatCard({
  label,
  value,
  active,
  colorClass,
  onClick,
}: {
  label: string
  value: number | string
  active: boolean
  colorClass: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-[7.5rem] flex-1 items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all',
        active
          ? 'border-[var(--theme-accent)] bg-[var(--theme-accent-soft)]'
          : 'border-[var(--theme-border)] bg-[var(--theme-card)] hover:border-[var(--theme-accent)]/50 hover:bg-[var(--theme-card2)]',
      )}
    >
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', colorClass)} />
      <div>
        <p className="text-lg font-semibold leading-none text-[var(--theme-text)]">
          {value}
        </p>
        <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--theme-muted)]">
          {label}
        </p>
      </div>
    </button>
  )
}

export function TeamOverview({
  agents,
  filter,
  onFilterChange,
}: TeamOverviewProps) {
  const activeCount = agents.filter((agent) => agent.status === 'active').length
  const idleCount = agents.filter((agent) => agent.status === 'idle').length
  const offlineCount = agents.filter(
    (agent) => agent.status === 'offline',
  ).length
  const blockedCount = agents.filter(
    (agent) => agent.status === 'blocked',
  ).length
  const errorCount = agents.filter((agent) => agent.status === 'error').length
  const needsSetupCount = agents.filter((agent) => agent.needsSetup).length

  const totalTokens = agents.reduce((sum, agent) => {
    const usage = agent.latestSession?.usage
    if (!usage) return sum
    return (
      sum +
      (usage.totalTokens ?? usage.tokens ?? usage.promptTokens ?? 0) +
      (usage.completionTokens ?? 0)
    )
  }, 0)

  return (
    <section className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4 shadow-[0_20px_60px_color-mix(in_srgb,var(--theme-shadow)_10%,transparent)]">
      <div className="flex flex-wrap items-center gap-3">
        <StatCard
          label="Active"
          value={activeCount}
          colorClass="bg-emerald-500"
          active={filter === 'active'}
          onClick={() => onFilterChange(filter === 'active' ? 'all' : 'active')}
        />
        <StatCard
          label="Idle"
          value={idleCount}
          colorClass="bg-primary-300"
          active={filter === 'idle'}
          onClick={() => onFilterChange(filter === 'idle' ? 'all' : 'idle')}
        />
        <StatCard
          label="Offline"
          value={offlineCount}
          colorClass="bg-neutral-400"
          active={filter === 'offline'}
          onClick={() =>
            onFilterChange(filter === 'offline' ? 'all' : 'offline')
          }
        />
        <StatCard
          label="Blocked"
          value={blockedCount}
          colorClass="bg-rose-500"
          active={filter === 'blocked'}
          onClick={() =>
            onFilterChange(filter === 'blocked' ? 'all' : 'blocked')
          }
        />
        <StatCard
          label="Error"
          value={errorCount}
          colorClass="bg-red-500"
          active={filter === 'error'}
          onClick={() => onFilterChange(filter === 'error' ? 'all' : 'error')}
        />
        <StatCard
          label="Needs setup"
          value={needsSetupCount}
          colorClass="bg-amber-400"
          active={filter === 'needsSetup'}
          onClick={() =>
            onFilterChange(filter === 'needsSetup' ? 'all' : 'needsSetup')
          }
        />
        <div className="flex min-w-[8rem] flex-1 flex-col justify-center rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
          <p className="text-lg font-semibold leading-none text-[var(--theme-text)]">
            {totalTokens > 0 ? totalTokens.toLocaleString() : '—'}
          </p>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--theme-muted)]">
            Session tokens
          </p>
        </div>
      </div>
    </section>
  )
}
