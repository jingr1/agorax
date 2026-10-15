import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import type { AgentsHealthSummary } from '@/hooks/use-agent-snapshot'

export type SwarmHealthBarProps = {
  health: AgentsHealthSummary | null
  checkedAt: number | null
  agentCount: number
}

function formatDate(value?: number | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/**
 * Compact Swarm health strip — replaces the full Agent Bus panel.
 * Deep-links to /swarm for ops; keeps KPI glanceable on Agents.
 */
export function SwarmHealthBar({
  health,
  checkedAt,
  agentCount,
}: SwarmHealthBarProps) {
  const online = health?.online ?? 0
  const needsHuman = health?.needsHuman ?? 0
  const blocked = health?.blocked ?? 0
  const degraded = health?.degraded ?? false

  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-2xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        degraded
          ? 'border-amber-300/50 bg-amber-50/80 dark:bg-amber-950/20'
          : 'border-[var(--theme-border)] bg-[var(--theme-card)]',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              degraded ? 'bg-amber-500' : 'bg-emerald-500',
            )}
            aria-hidden
          />
          <span className="font-semibold text-[var(--theme-text)]">
            Swarm health
          </span>
          <span className="text-xs text-[var(--theme-muted)]">
            {formatDate(checkedAt)}
          </span>
        </div>
        <span className="text-[var(--theme-muted)]">
          <strong className="text-[var(--theme-text)]">{online}</strong>/{agentCount}{' '}
          online
        </span>
        {needsHuman > 0 ? (
          <span className="text-amber-700 dark:text-amber-300">
            {needsHuman} needs human
          </span>
        ) : null}
        {blocked > 0 ? (
          <span className="text-rose-700 dark:text-rose-300">
            {blocked} blocked
          </span>
        ) : null}
      </div>
      <Link
        to="/swarm"
        className="inline-flex shrink-0 items-center justify-center rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)] transition-colors hover:border-[var(--theme-accent)] hover:bg-[var(--theme-accent-soft)]"
      >
        Open Swarm
      </Link>
    </section>
  )
}

/** @deprecated Use SwarmHealthBar. Kept for any residual imports. */
export { SwarmHealthBar as AgentBusPanel }
export type AgentBusData = {
  crew: Array<unknown>
  workers: Array<unknown>
  entries: Array<unknown>
  healthSummary: Record<string, unknown>
  lastCheck: number
}
