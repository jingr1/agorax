'use client'

/**
 * MissionSurface — IssueSurface-inspired shell (board/list/swimlane).
 * List entity is always Mission; Tasks only in detail.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MissionStatus, MissionSummary } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import { fetchMissions, patchMission } from '@/lib/mission-control-api'
import { CreateMissionButton } from './components/create-task-button'
import { ToolbarSearch, ToolbarSelect } from '@/components/layout/toolbar'
import { toast } from '@/components/ui/toast'

export type MissionViewMode = 'board' | 'list' | 'swimlane'

const STATUSES: Array<{ id: MissionStatus; label: string }> = [
  { id: 'todo', label: 'Todo' },
  { id: 'ready', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
]

export const STATUS_COLORS: Record<MissionStatus, string> = {
  todo: '#3b82f6',
  ready: '#0ea5e9',
  running: '#f97316',
  review: '#a855f7',
  blocked: '#ef4444',
  done: '#22c55e',
  cancelled: '#6b7280',
}

const MISSIONS_QUERY_KEY = ['mission-control', 'missions'] as const
const PREFS_KEY = 'agorax-mission-surface-prefs-v1'

type SurfacePrefs = {
  viewMode: MissionViewMode
  statusFilter: MissionStatus | 'all'
  swimlaneBy: 'assignee' | 'project'
}

function loadPrefs(): Partial<SurfacePrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<SurfacePrefs> & {
      viewMode?: string
    }
    // table mode removed — map legacy prefs to list
    if (parsed.viewMode === 'table') parsed.viewMode = 'list'
    if (
      parsed.viewMode &&
      parsed.viewMode !== 'board' &&
      parsed.viewMode !== 'list' &&
      parsed.viewMode !== 'swimlane'
    ) {
      parsed.viewMode = 'board'
    }
    return parsed as Partial<SurfacePrefs>
  } catch {
    return {}
  }
}

export function resolveStatus(m: MissionSummary): MissionStatus {
  return (m.status ??
    m.boardLane ??
    m.derivedStatus ??
    m.lane ??
    'todo') as MissionStatus
}

function assigneeLabel(m: MissionSummary): string {
  if (m.assignee?.type === 'chat_group')
    return `group:${m.assignee.id.slice(0, 8)}`
  if (m.assignee?.type === 'agent') return m.assignee.id
  if (m.pipelineId) return `pipeline:${m.pipelineId}`
  return m.currentAssignee ?? '—'
}

export function isActiveWorker(m: MissionSummary): boolean {
  const status = resolveStatus(m)
  return status === 'running' || status === 'review' || status === 'ready'
}

function selectId(m: MissionSummary): string {
  return m.missionId ?? ''
}

type MissionSurfaceProps = {
  onSelectMission: (missionId: string | null) => void
}

export function MissionSurface({ onSelectMission }: MissionSurfaceProps) {
  const prefs = useMemo(() => loadPrefs(), [])
  const [viewMode, setViewMode] = useState<MissionViewMode>(
    prefs.viewMode ?? 'board',
  )
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<MissionStatus | 'all'>(
    prefs.statusFilter ??
      (prefs as { laneFilter?: MissionStatus | 'all' }).laneFilter ??
      'all',
  )
  const [agentsWorkingOnly, setAgentsWorkingOnly] = useState(false)
  const [swimlaneBy, setSwimlaneBy] = useState<'assignee' | 'project'>(
    prefs.swimlaneBy ?? 'assignee',
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [dragMissionId, setDragMissionId] = useState<string | null>(null)
  const [dragOverLane, setDragOverLane] = useState<MissionStatus | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    const next: SurfacePrefs = { viewMode, statusFilter, swimlaneBy }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      /* ignore quota */
    }
  }, [viewMode, statusFilter, swimlaneBy])

  const missionsQuery = useQuery({
    queryKey: MISSIONS_QUERY_KEY,
    queryFn: fetchMissions,
    refetchInterval: 30_000,
  })

  const missions = missionsQuery.data?.missions ?? []

  const moveMutation = useMutation({
    mutationFn: async (input: { missionId: string; status: MissionStatus }) =>
      patchMission(input.missionId, { status: input.status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY })
    },
    onError: (error: Error) => {
      toast(error.message || 'Failed to move mission', { type: 'error' })
    },
  })

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return missions.filter((m) => {
      if (statusFilter !== 'all' && resolveStatus(m) !== statusFilter)
        return false
      if (agentsWorkingOnly && !isActiveWorker(m)) return false
      if (!q) return true
      return (
        m.title.toLowerCase().includes(q) ||
        (m.pipelineId ?? '').includes(q) ||
        assigneeLabel(m).toLowerCase().includes(q)
      )
    })
  }, [missions, filter, statusFilter, agentsWorkingOnly])

  const workingCount = useMemo(
    () => missions.filter(isActiveWorker).length,
    [missions],
  )

  const byStatus = useMemo(() => {
    const map = new Map<MissionStatus, MissionSummary[]>()
    for (const lane of STATUSES) map.set(lane.id, [])
    for (const m of filtered) {
      const lane = resolveStatus(m)
      const list = map.get(lane) ?? []
      list.push(m)
      map.set(lane, list)
    }
    return map
  }, [filtered])

  const swimLanes = useMemo(() => {
    const map = new Map<string, MissionSummary[]>()
    for (const m of filtered) {
      const key =
        swimlaneBy === 'project'
          ? (m.projectId ?? 'No project')
          : assigneeLabel(m)
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [filtered, swimlaneBy])

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function batchMove(status: MissionStatus) {
    const targets = missions.filter((m) => selectedIds.has(selectId(m)))
    for (const m of targets) {
      await moveMutation.mutateAsync({ missionId: selectId(m), status })
    }
    setSelectedIds(new Set())
    toast(`Moved ${targets.length} mission(s)`, { type: 'success' })
  }

  function onDropStatus(statusId: MissionStatus) {
    setDragOverLane(null)
    if (!dragMissionId) return
    void moveMutation.mutateAsync({
      missionId: dragMissionId,
      status: statusId,
    })
    setDragMissionId(null)
  }

  const openMission = useCallback(
    (id: string) => onSelectMission(id),
    [onSelectMission],
  )
  const startDrag = useCallback((id: string) => setDragMissionId(id), [])
  const endDrag = useCallback(() => {
    setDragMissionId(null)
    setDragOverLane(null)
  }, [])

  function laneDropProps(id: MissionStatus) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!dragMissionId) return
        e.preventDefault()
        if (dragOverLane !== id) setDragOverLane(id)
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragOverLane((prev) => (prev === id ? null : prev))
      },
      onDrop: () => onDropStatus(id),
    }
  }

  const isDragging = dragMissionId !== null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div
          className="flex h-9 items-center gap-0.5 rounded-lg border border-border bg-input p-0.5"
          role="tablist"
          aria-label="View"
        >
          {(['board', 'list', 'swimlane'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={cn(
                'h-full rounded-md px-3 text-xs capitalize transition-colors',
                viewMode === mode
                  ? 'bg-card font-medium text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <ToolbarSearch
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter missions…"
          className="basis-full sm:basis-0 sm:max-w-xs"
        />
        <ToolbarSelect
          label="Status"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as MissionStatus | 'all')
          }
        >
          <option value="all">All</option>
          {STATUSES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </ToolbarSelect>
        {viewMode === 'swimlane' ? (
          <ToolbarSelect
            label="Group by"
            value={swimlaneBy}
            onChange={(e) =>
              setSwimlaneBy(e.target.value as 'assignee' | 'project')
            }
          >
            <option value="assignee">Assignee</option>
            <option value="project">Project</option>
          </ToolbarSelect>
        ) : null}
        <button
          type="button"
          aria-pressed={agentsWorkingOnly}
          onClick={() => setAgentsWorkingOnly((v) => !v)}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs transition-colors',
            agentsWorkingOnly
              ? 'border-warning/50 bg-warning/10 text-warning'
              : 'border-border bg-input text-fg-muted hover:text-fg',
          )}
        >
          <span className="size-1.5 rounded-full bg-warning" />
          Agents working
          <span className="rounded bg-card-2 px-1.5 text-[11px] tabular-nums text-fg">
            {workingCount}
          </span>
        </button>
        {selectedIds.size > 0 ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-fg-muted">
              {selectedIds.size} selected
            </span>
            <ToolbarSelect
              label="Move to"
              defaultValue=""
              onChange={(e) => {
                const value = e.target.value as MissionStatus | ''
                if (!value) return
                void batchMove(value)
                e.target.value = ''
              }}
            >
              <option value="" disabled>
                Status…
              </option>
              {STATUSES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </ToolbarSelect>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {missionsQuery.isLoading ? (
          <p className="p-4 text-xs text-fg-muted">Loading missions…</p>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-fg-muted">
              {missions.length === 0
                ? 'No missions yet.'
                : 'No missions match these filters.'}
            </p>
            {missions.length === 0 ? (
              <CreateMissionButton variant="inline" />
            ) : null}
          </div>
        ) : viewMode === 'board' ? (
          <div className="flex h-full gap-3 overflow-x-auto p-4">
            {STATUSES.map((lane) => {
              const rows = byStatus.get(lane.id) ?? []
              const isOver = dragOverLane === lane.id
              return (
                <div
                  key={lane.id}
                  className={cn(
                    'flex min-w-[11rem] flex-1 basis-0 flex-col rounded-xl border bg-panel transition-colors',
                    isOver ? 'border-accent bg-accent/5' : 'border-border',
                  )}
                  {...laneDropProps(lane.id)}
                >
                  <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: STATUS_COLORS[lane.id] }}
                    />
                    <span className="text-xs font-semibold text-fg">
                      {lane.label}
                    </span>
                    <span className="ml-auto rounded bg-card-2 px-1.5 text-[11px] tabular-nums text-fg-muted">
                      {rows.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                    {rows.map((m) => (
                      <MissionCard
                        key={selectId(m)}
                        mission={m}
                        onOpen={openMission}
                        onDragStart={startDrag}
                        onDragEnd={endDrag}
                      />
                    ))}
                    {rows.length === 0 ? (
                      <div
                        className={cn(
                          'rounded-lg border border-dashed py-6 text-center text-[11px] text-fg-muted',
                          isDragging ? 'border-accent/40' : 'border-border',
                        )}
                      >
                        {isDragging ? 'Drop here' : 'No missions'}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ) : viewMode === 'list' ? (
          <div className="h-full space-y-5 overflow-y-auto p-4">
            {STATUSES.map((lane) => {
              const rows = byStatus.get(lane.id) ?? []
              if (rows.length === 0) return null
              return (
                <section key={lane.id}>
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: STATUS_COLORS[lane.id] }}
                    />
                    {lane.label}
                    <span className="rounded bg-card-2 px-1.5 text-[11px] font-normal tabular-nums text-fg-muted">
                      {rows.length}
                    </span>
                  </h3>
                  <div className="overflow-hidden rounded-xl border border-border bg-panel">
                    <div className="hidden grid-cols-[auto_minmax(0,1fr)_10rem_8rem_4rem] gap-3 border-b border-border px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-fg-muted sm:grid">
                      <span className="w-4" />
                      <span>Title</span>
                      <span>Assignee</span>
                      <span>Pipeline</span>
                      <span className="text-right">Tasks</span>
                    </div>
                    <div className="divide-y divide-border">
                      {rows.map((m) => (
                        <div
                          key={selectId(m)}
                          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-hover sm:grid-cols-[auto_minmax(0,1fr)_10rem_8rem_4rem]"
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--theme-accent)]"
                            checked={selectedIds.has(selectId(m))}
                            onChange={() => toggleSelect(selectId(m))}
                          />
                          <button
                            type="button"
                            className="min-w-0 text-left text-sm"
                            onClick={() => onSelectMission(selectId(m))}
                          >
                            <span className="line-clamp-2 font-medium text-fg">
                              {m.title}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-fg-muted sm:hidden">
                              {assigneeLabel(m)}
                              {m.pipelineId ? ` · ${m.pipelineId}` : ''}
                              {` · ${taskCountLabel(m.taskCount)}`}
                            </span>
                          </button>
                          <span className="hidden truncate text-xs text-fg-muted sm:block">
                            {assigneeLabel(m)}
                          </span>
                          <span className="hidden truncate text-xs text-fg-muted sm:block">
                            {m.pipelineId ?? '—'}
                          </span>
                          <span className="hidden text-right text-xs tabular-nums text-fg-muted sm:block">
                            {m.taskCount}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="h-full space-y-5 overflow-auto p-4">
            {swimLanes.map(([laneName, rows]) => (
              <section key={laneName}>
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg">
                  {laneName}
                  <span className="rounded bg-card-2 px-1.5 text-[11px] font-normal tabular-nums text-fg-muted">
                    {rows.length}
                  </span>
                </h3>
                <div className="flex gap-2">
                  {STATUSES.map((lane) => {
                    const cells = rows.filter(
                      (m) => resolveStatus(m) === lane.id,
                    )
                    const isOver = dragOverLane === lane.id
                    return (
                      <div
                        key={lane.id}
                        className={cn(
                          'min-w-[10rem] flex-1 basis-0 space-y-1.5 rounded-xl border bg-panel p-2 transition-colors',
                          isOver
                            ? 'border-accent bg-accent/5'
                            : 'border-border',
                        )}
                        {...laneDropProps(lane.id)}
                      >
                        <div className="flex items-center gap-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ background: STATUS_COLORS[lane.id] }}
                          />
                          {lane.label}
                        </div>
                        {cells.map((m) => (
                          <MissionCard
                            key={selectId(m)}
                            mission={m}
                            compact
                            onOpen={openMission}
                            onDragStart={startDrag}
                            onDragEnd={endDrag}
                          />
                        ))}
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function taskCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}`
}

function workerLabel(mission: MissionSummary): string {
  if (mission.currentAssignee) {
    return mission.currentStage &&
      mission.currentStage !== mission.currentAssignee
      ? `${mission.currentAssignee} · ${mission.currentStage}`
      : mission.currentAssignee
  }
  if (mission.currentStage) return mission.currentStage
  const assignee = assigneeLabel(mission)
  return assignee === '—' ? 'Unassigned' : assignee
}

/** Memoised: the 30s refetch keeps unchanged mission objects by reference. */
const MissionCard = memo(function MissionCardView({
  mission,
  onOpen,
  compact,
  onDragStart,
  onDragEnd,
}: {
  mission: MissionSummary
  onOpen: (id: string) => void
  compact?: boolean
  onDragStart?: (id: string) => void
  onDragEnd?: () => void
}) {
  const id = selectId(mission)
  return (
    <button
      type="button"
      draggable={Boolean(onDragStart)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(id)
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(id)}
      className={cn(
        'w-full rounded-lg border border-border bg-card text-left transition-colors hover:border-accent/50 hover:bg-hover',
        compact ? 'p-2' : 'p-2.5',
      )}
    >
      <span
        className={cn(
          'line-clamp-2 block font-medium leading-snug text-fg',
          compact ? 'text-xs' : 'text-[13px]',
        )}
      >
        {mission.title}
      </span>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
        {isActiveWorker(mission) ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-warning"
            title="Agent working"
            aria-label="Agent working"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{workerLabel(mission)}</span>
        <span className="shrink-0 tabular-nums">
          {taskCountLabel(mission.taskCount)}
        </span>
      </div>
    </button>
  )
})
