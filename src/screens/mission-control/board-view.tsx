'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MissionStatus, TaskSummary } from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import { fetchTasks } from '@/lib/mission-control-api'
import { CreateTaskButton } from './components/create-task-button'

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

const TASKS_QUERY_KEY = ['mission-control', 'tasks'] as const

type TaskKpiFilter = 'all' | 'in_progress' | 'blocked' | 'pending_human' | 'done'

function resolveStatus(task: TaskSummary): MissionStatus {
  return (task.status ?? task.derivedStatus ?? task.lane ?? 'todo') as MissionStatus
}

function isInProgress(task: TaskSummary): boolean {
  const status = resolveStatus(task)
  return status === 'running' || status === 'review' || status === 'ready'
}

function isBlocked(task: TaskSummary): boolean {
  return resolveStatus(task) === 'blocked'
}

function isPendingHuman(task: TaskSummary): boolean {
  const status = resolveStatus(task)
  return status === 'blocked' || status === 'review'
}

function isDone(task: TaskSummary): boolean {
  return resolveStatus(task) === 'done'
}

function KpiChip({
  label,
  value,
  active,
  tone,
  onClick,
}: {
  label: string
  value: number
  active: boolean
  tone: 'slate' | 'amber' | 'rose' | 'emerald'
  onClick: () => void
}) {
  const toneClasses = {
    slate: 'border-slate-400/30 data-[active=true]:bg-slate-500/15',
    amber: 'border-amber-400/30 data-[active=true]:bg-amber-500/15',
    rose: 'border-rose-400/30 data-[active=true]:bg-rose-500/15',
    emerald: 'border-emerald-400/30 data-[active=true]:bg-emerald-500/15',
  }
  return (
    <button
      type="button"
      data-active={active}
      onClick={onClick}
      className={cn(
        'flex min-w-[7rem] flex-1 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-[var(--theme-hover)]',
        toneClasses[tone],
        active && 'ring-1 ring-[var(--theme-accent)]',
      )}
    >
      <span className="text-[11px] text-[var(--theme-muted)]">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </button>
  )
}

export function BoardView({
  onSelectTask,
}: {
  onSelectTask: (taskId: string) => void
}) {
  const [kpiFilter, setKpiFilter] = useState<TaskKpiFilter>('all')
  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: fetchTasks,
    refetchInterval: 30_000,
  })

  const tasks = tasksQuery.data?.tasks ?? []

  const kpi = useMemo(() => {
    let inProgress = 0
    let blocked = 0
    let pendingHuman = 0
    let done = 0
    for (const task of tasks) {
      if (isDone(task)) done += 1
      if (isInProgress(task)) inProgress += 1
      if (isBlocked(task)) blocked += 1
      if (isPendingHuman(task)) pendingHuman += 1
    }
    return { inProgress, blocked, pendingHuman, done }
  }, [tasks])

  const filteredTasks = useMemo(() => {
    switch (kpiFilter) {
      case 'in_progress':
        return tasks.filter(isInProgress)
      case 'blocked':
        return tasks.filter(isBlocked)
      case 'pending_human':
        return tasks.filter(isPendingHuman)
      case 'done':
        return tasks.filter(isDone)
      default:
        return tasks
    }
  }, [tasks, kpiFilter])

  const byLane = useMemo(() => {
    const map = new Map<MissionStatus, Array<TaskSummary>>()
    for (const lane of STATUSES) map.set(lane.id, [])
    for (const task of filteredTasks) {
      const lane = resolveStatus(task)
      const bucket = map.get(lane) ?? map.get('todo')!
      bucket.push(task)
    }
    return map
  }, [filteredTasks])

  function toggleFilter(next: TaskKpiFilter) {
    setKpiFilter((prev) => (prev === next ? 'all' : next))
  }

  if (!tasksQuery.isLoading && tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="max-w-sm space-y-2">
          <h2 className="text-base font-semibold">No missions yet</h2>
          <p className="text-sm text-[var(--theme-muted)]">
            Create a task to start a multi-agent pipeline. Agent setup lives on
            the Agents page.
          </p>
        </div>
        <CreateTaskButton />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-[var(--theme-border)] px-4 py-3 sm:px-6">
        <div className="flex flex-wrap gap-2">
          <KpiChip
            label="In progress"
            value={kpi.inProgress}
            active={kpiFilter === 'in_progress'}
            tone="amber"
            onClick={() => toggleFilter('in_progress')}
          />
          <KpiChip
            label="Blocked"
            value={kpi.blocked}
            active={kpiFilter === 'blocked'}
            tone="rose"
            onClick={() => toggleFilter('blocked')}
          />
          <KpiChip
            label="Pending human"
            value={kpi.pendingHuman}
            active={kpiFilter === 'pending_human'}
            tone="amber"
            onClick={() => toggleFilter('pending_human')}
          />
          <KpiChip
            label="Done"
            value={kpi.done}
            active={kpiFilter === 'done'}
            tone="emerald"
            onClick={() => toggleFilter('done')}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="flex h-full min-w-[900px] gap-3">
          {STATUSES.map((lane) => {
            const laneTasks = byLane.get(lane.id) ?? []
            return (
              <div
                key={lane.id}
                className="flex w-64 flex-col rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)]"
              >
                <div
                  className="flex items-center justify-between rounded-t-xl border-b border-[var(--theme-border)] px-3 py-2"
                  style={{
                    borderTopWidth: 2,
                    borderTopColor: STATUS_COLORS[lane.id],
                  }}
                >
                  <span className="text-xs font-semibold">{lane.label}</span>
                  <span className="text-[10px] text-[var(--theme-muted)]">
                    {laneTasks.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 overflow-y-auto p-2">
                  {laneTasks.map((task) => (
                    <button
                      key={task.missionId}
                      type="button"
                      onClick={() => {
                        if (task.missionId) onSelectTask(task.missionId)
                      }}
                      className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3 text-left transition-colors hover:border-[var(--theme-accent)] hover:bg-[var(--theme-hover)]"
                    >
                      <div className="text-xs font-medium">{task.title}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                        {task.currentAssignee ? (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-800">
                            {task.currentAssignee}
                            {task.currentStage &&
                            task.currentStage !== task.currentAssignee
                              ? ` · ${task.currentStage}`
                              : ''}
                          </span>
                        ) : task.currentStage ? (
                          <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-slate-600">
                            {task.currentStage}
                          </span>
                        ) : (
                          <span className="text-[var(--theme-muted)]">
                            No active worker
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                  {laneTasks.length === 0 && (
                    <div className="py-6 text-center text-[10px] text-[var(--theme-muted)]">
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
