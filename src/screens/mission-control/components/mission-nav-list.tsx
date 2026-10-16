import { Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { memo, useMemo, useState } from 'react'
import { STATUS_COLORS, resolveStatus } from '../mission-surface'
import type { MissionSummary } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'

type MissionNavListProps = {
  missions: Array<MissionSummary>
  activeMissionId: string | null
  onSelect: (missionId: string) => void
}

/** Detail-page mission rail — row style mirrors the group-chat room list. */
export const MissionNavList = memo(function MissionNavListView({
  missions,
  activeMissionId,
  onSelect,
}: MissionNavListProps) {
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return missions
    return missions.filter((m) => m.title.toLowerCase().includes(q))
  }, [missions, query])

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-[var(--theme-sidebar)]">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
          Missions · {missions.length}
        </span>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search missions…"
            className="h-8 w-full rounded-lg border border-border bg-input pl-7 pr-2 text-xs text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-accent"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {visible.map((m) => {
          const id = m.missionId
          const isActive = activeMissionId === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (id) onSelect(id)
              }}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-primary-200',
                isActive && 'bg-primary-200',
              )}
            >
              <span
                className="mt-1.5 size-2 shrink-0 rounded-full"
                style={{ background: STATUS_COLORS[resolveStatus(m)] }}
                title={resolveStatus(m)}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'line-clamp-2 text-sm font-medium leading-snug',
                    isActive ? 'text-accent-500' : 'text-primary-900',
                  )}
                >
                  {m.title}
                </span>
                <span className="mt-0.5 flex items-center text-xs text-primary-500">
                  <span className="truncate">
                    {[
                      m.currentAssignee,
                      `${m.taskCount} ${m.taskCount === 1 ? 'task' : 'tasks'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </span>
            </button>
          )
        })}
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">
            No matching missions
          </p>
        ) : null}
      </div>
    </aside>
  )
})
