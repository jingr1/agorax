'use client'

/**
 * MissionSurface — IssueSurface-inspired shell (board/list/swimlane).
 * List entity is always Mission; Tasks only in detail.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MissionStatus, MissionSummary } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import { fetchMissions, patchMission } from '@/lib/mission-control-api'
import { CreateMissionButton } from './components/create-task-button'
import { Button } from '@/components/ui/button'
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

const STATUS_COLORS: Record<MissionStatus, string> = {
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

function resolveStatus(m: MissionSummary): MissionStatus {
  return (m.status ?? m.boardLane ?? m.derivedStatus ?? m.lane ?? 'todo') as MissionStatus
}

function assigneeLabel(m: MissionSummary): string {
  if (m.assignee?.type === 'chat_group') return `group:${m.assignee.id.slice(0, 8)}`
  if (m.assignee?.type === 'agent') return m.assignee.id
  if (m.pipelineId) return `pipeline:${m.pipelineId}`
  return m.currentAssignee ?? '—'
}

function isActiveWorker(m: MissionSummary): boolean {
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
      if (statusFilter !== 'all' && resolveStatus(m) !== statusFilter) return false
      if (agentsWorkingOnly && !isActiveWorker(m)) return false
      if (!q) return true
      return (
        m.title.toLowerCase().includes(q) ||
        (m.pipelineId ?? '').includes(q) ||
        assigneeLabel(m).toLowerCase().includes(q)
      )
    })
  }, [missions, filter, statusFilter, agentsWorkingOnly])

  const workingCount = missions.filter(isActiveWorker).length

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
          ? m.projectId ?? 'No project'
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
    if (!dragMissionId) return
    void moveMutation.mutateAsync({ missionId: dragMissionId, status: statusId })
    setDragMissionId(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--theme-border)] bg-[var(--theme-card)] px-4 py-2">
        <div className="flex gap-0.5 rounded-lg bg-[var(--theme-input)] p-0.5">
          {(['board', 'list', 'swimlane'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={viewMode === mode ? 'default' : 'ghost'}
              onClick={() => setViewMode(mode)}
              className="h-7 capitalize text-[11px]"
            >
              {mode}
            </Button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter missions…"
          className="min-w-[10rem] flex-1 rounded-md field-surface px-2 py-1 text-xs"
        />
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as MissionStatus | 'all')
          }
          className="control-surface rounded-md px-2 py-1 text-xs"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant={agentsWorkingOnly ? 'default' : 'secondary'}
          onClick={() => setAgentsWorkingOnly((v) => !v)}
          className="h-7 text-[11px]"
        >
          Agents working ({workingCount})
        </Button>
        {viewMode === 'swimlane' ? (
          <select
            value={swimlaneBy}
            onChange={(e) =>
              setSwimlaneBy(e.target.value as 'assignee' | 'project')
            }
            className="control-surface rounded-md px-2 py-1 text-xs"
          >
            <option value="assignee">Swim by assignee</option>
            <option value="project">Swim by project</option>
          </select>
        ) : null}
        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--theme-muted)]">
              {selectedIds.size} selected
            </span>
            <select
              defaultValue=""
              onChange={(e) => {
                const value = e.target.value as MissionStatus | ''
                if (!value) return
                void batchMove(value)
                e.target.value = ''
              }}
              className="control-surface rounded-md px-2 py-1 text-xs"
            >
              <option value="" disabled>
                Batch move…
              </option>
              {STATUSES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {missionsQuery.isLoading ? (
          <p className="text-xs text-[var(--theme-muted)]">Loading missions…</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-[var(--theme-muted)]">No missions yet.</p>
            <CreateMissionButton variant="inline" />
          </div>
        ) : viewMode === 'board' ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {STATUSES.map((lane) => (
              <div
                key={lane.id}
                className="flex w-64 shrink-0 flex-col rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)]"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDropStatus(lane.id)}
              >
                <div className="flex items-center gap-2 border-b border-[var(--theme-border)] px-3 py-2">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: STATUS_COLORS[lane.id] }}
                  />
                  <span className="text-xs font-semibold">{lane.label}</span>
                  <span className="ml-auto text-[10px] text-[var(--theme-muted)]">
                    {byStatus.get(lane.id)?.length ?? 0}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {(byStatus.get(lane.id) ?? []).map((m) => (
                    <MissionCard
                      key={selectId(m)}
                      mission={m}
                      draggable
                      onDragStart={() => setDragMissionId(selectId(m))}
                      onOpen={() => onSelectMission(selectId(m))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : viewMode === 'list' ? (
          <div className="space-y-4">
            {STATUSES.map((lane) => {
              const rows = byStatus.get(lane.id) ?? []
              if (rows.length === 0) return null
              return (
                <section key={lane.id}>
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: STATUS_COLORS[lane.id] }}
                    />
                    {lane.label}
                    <span className="font-normal normal-case tracking-normal">
                      ({rows.length})
                    </span>
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-[var(--theme-border)]">
                    <div className="hidden grid-cols-[auto_minmax(0,1fr)_7rem_6rem_3.5rem] gap-2 border-b border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--theme-muted)] sm:grid">
                      <span className="w-4" />
                      <span>Title</span>
                      <span>Assignee</span>
                      <span>Pipeline</span>
                      <span className="text-right">Tasks</span>
                    </div>
                    <div className="divide-y divide-[var(--theme-border)]">
                      {rows.map((m) => (
                        <div
                          key={selectId(m)}
                          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-3 py-2 hover:bg-[var(--theme-hover)] sm:grid-cols-[auto_minmax(0,1fr)_7rem_6rem_3.5rem]"
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(selectId(m))}
                            onChange={() => toggleSelect(selectId(m))}
                          />
                          <button
                            type="button"
                            className="min-w-0 text-left text-sm"
                            onClick={() => onSelectMission(selectId(m))}
                          >
                            <span className="line-clamp-2 font-medium">
                              {m.title}
                            </span>
                            <span className="mt-0.5 block text-[10px] text-[var(--theme-muted)] sm:hidden">
                              {assigneeLabel(m)}
                              {m.pipelineId ? ` · ${m.pipelineId}` : ''}
                              {` · ${m.taskCount} tasks`}
                            </span>
                          </button>
                          <span className="hidden truncate text-[11px] text-[var(--theme-muted)] sm:block">
                            {assigneeLabel(m)}
                          </span>
                          <span className="hidden truncate text-[11px] text-[var(--theme-muted)] sm:block">
                            {m.pipelineId ?? '—'}
                          </span>
                          <span className="hidden text-right text-[11px] tabular-nums text-[var(--theme-muted)] sm:block">
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
          <div className="space-y-4">
            {swimLanes.map(([laneName, rows]) => (
              <section key={laneName}>
                <h3 className="mb-2 text-xs font-semibold text-[var(--theme-muted)]">
                  {laneName}
                </h3>
                <div className="flex gap-2 overflow-x-auto">
                  {STATUSES.map((lane) => (
                    <div
                      key={lane.id}
                      className="w-48 shrink-0 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-2"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDropStatus(lane.id)}
                    >
                      <div className="mb-1 text-[10px] font-medium uppercase text-[var(--theme-muted)]">
                        {lane.label}
                      </div>
                      {rows
                        .filter((m) => resolveStatus(m) === lane.id)
                        .map((m) => (
                          <MissionCard
                            key={selectId(m)}
                            mission={m}
                            compact
                            draggable
                            onDragStart={() => setDragMissionId(selectId(m))}
                            onOpen={() => onSelectMission(selectId(m))}
                          />
                        ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MissionCard({
  mission,
  onOpen,
  compact,
  draggable,
  onDragStart,
}: {
  mission: MissionSummary
  onOpen: () => void
  compact?: boolean
  draggable?: boolean
  onDragStart?: () => void
}) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        'w-full rounded-md border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2 text-left transition-colors hover:border-[var(--theme-accent)]',
        compact && 'mb-1',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium leading-snug">{mission.title}</span>
        {isActiveWorker(mission) ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-700">
            Working
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--theme-muted)]">
        <span className="truncate">
          {mission.currentAssignee
            ? `${mission.currentAssignee}${
                mission.currentStage &&
                mission.currentStage !== mission.currentAssignee
                  ? ` · ${mission.currentStage}`
                  : ''
              }`
            : mission.currentStage
              ? mission.currentStage
              : assigneeLabel(mission)}
        </span>
        <span>{mission.taskCount} tasks</span>
      </div>
    </button>
  )
}
