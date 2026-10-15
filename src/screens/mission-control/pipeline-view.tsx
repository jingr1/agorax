'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type {
  MissionDetail,
  MissionSummary,
  MissionTaskRow,
  PipelineStage,
  TaskRun,
} from '@/lib/mission-control-api'
import { cn } from '@/lib/utils'
import {
  deleteMission,
  fetchAgentsStatus,
  fetchMissionDetail,
  fetchMissions,
  fetchProjects,
  patchMission,
  startMission,
} from '@/lib/mission-control-api'
import {
  buildTimelineFromEvents,
  taskSummaryLine,
} from '@/lib/mission-detail-format'
import { createRoomFromMission } from '@/lib/group-chat-api'
import { toast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { SpecField } from './components/spec-field'

const MISSIONS_QUERY_KEY = ['mission-control', 'missions'] as const
const PROJECTS_QUERY_KEY = ['mission-control', 'projects'] as const

function StageBar({
  stages,
  currentStageId,
}: {
  stages: Array<PipelineStage>
  currentStageId: string | null
}) {
  if (stages.length === 0) return null
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2">
      {stages.map((stage, index) => {
        const isCurrent = stage.assignmentId === currentStageId
        const isDone = stage.state === 'done' || stage.state === 'checkpointed'
        const isBlocked =
          stage.state === 'blocked' || stage.state === 'needs_input'
        return (
          <div key={stage.assignmentId} className="flex items-center">
            <div
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium',
                isCurrent
                  ? 'border-[var(--theme-accent)] bg-[var(--theme-accent)] text-white'
                  : isDone
                    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700'
                    : isBlocked
                      ? 'border-red-400/40 bg-red-500/10 text-red-700'
                      : 'border-[var(--theme-border)] bg-[var(--theme-card)] text-[var(--theme-muted)]',
              )}
            >
              {stage.stageKey ?? stage.agent}
            </div>
            {index < stages.length - 1 && (
              <div className="mx-1 h-px w-4 bg-[var(--theme-border)]" />
            )}
          </div>
        )
      })}
    </div>
  )
}

function TasksTable({ tasks }: { tasks: Array<MissionTaskRow> }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--theme-border)] p-4 text-xs text-[var(--theme-muted)]">
        No tasks decomposed yet. Pipeline stages or an agent assignee will
        create tasks automatically.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--theme-border)]">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="border-b border-[var(--theme-border)] bg-[var(--theme-card)] text-[var(--theme-muted)]">
          <tr>
            <th className="px-3 py-2 font-medium">Created by</th>
            <th className="px-3 py-2 font-medium">→ Worker</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const expanded = expandedId === t.id
            const summary = taskSummaryLine(t.task)
            return (
              <tr
                key={t.id}
                className="border-b border-[var(--theme-border)] align-top"
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px]">
                  {t.createdByWorkerId ?? '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-medium">
                  {t.workerId}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {t.stageKey ?? '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-medium',
                      t.state === 'done' || t.state === 'checkpointed'
                        ? 'bg-emerald-500/15 text-emerald-700'
                        : t.state === 'dispatched'
                          ? 'bg-amber-500/15 text-amber-700'
                          : t.state === 'blocked' || t.state === 'needs_input'
                            ? 'bg-red-500/15 text-red-700'
                            : 'bg-slate-500/10 text-slate-600',
                    )}
                  >
                    {t.state}
                  </span>
                </td>
                <td className="min-w-[12rem] px-3 py-2 text-[var(--theme-muted)]">
                  <button
                    type="button"
                    className="w-full text-left hover:text-[var(--theme-text)]"
                    onClick={() =>
                      setExpandedId(expanded ? null : t.id)
                    }
                  >
                    <span className="block break-words">{summary}</span>
                    {expanded ? (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2 text-[10px] text-[var(--theme-text)]">
                        {t.task}
                      </pre>
                    ) : t.task.length > summary.length ? (
                      <span className="mt-0.5 block text-[10px] text-[var(--theme-accent)]">
                        Expand
                      </span>
                    ) : null}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Timeline({
  runs,
  events,
}: {
  runs: Array<TaskRun>
  events: Array<{ type: string; at: number; [key: string]: unknown }>
}) {
  const items = useMemo(
    () => buildTimelineFromEvents(events, runs),
    [runs, events],
  )

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-start gap-3 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
              <span className="break-words">{item.title}</span>
              {item.count ? (
                <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] text-slate-600">
                  ×{item.count}
                </span>
              ) : null}
            </div>
            {item.subtitle ? (
              <div className="mt-0.5 break-words text-[11px] text-[var(--theme-muted)]">
                {item.subtitle}
              </div>
            ) : null}
          </div>
          <div className="shrink-0 text-[10px] text-[var(--theme-muted)]">
            {item.at ? new Date(item.at).toLocaleTimeString() : ''}
          </div>
        </div>
      ))}
      {items.length === 0 ? (
        <p className="text-xs text-[var(--theme-muted)]">No activity yet.</p>
      ) : null}
    </div>
  )
}

function PropRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2 text-xs">
      <dt className="pt-1.5 text-[var(--theme-muted)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function selectClassName() {
  return 'control-surface w-full rounded-md px-2 py-1 text-xs'
}

function fieldClassName() {
  return 'field-surface w-full rounded-md px-2 py-1 text-xs'
}

export function PipelineView({
  selectedMissionId,
  onSelectMission,
}: {
  selectedMissionId: string | null
  onSelectMission: (id: string | null) => void
  /** @deprecated */
  selectedTaskId?: string | null
  /** @deprecated */
  onSelectTask?: (id: string | null) => void
}) {
  const activeId = selectedMissionId
  const select = onSelectMission
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [roomBusy, setRoomBusy] = useState(false)
  const [labelsDraft, setLabelsDraft] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [specDraft, setSpecDraft] = useState('')
  const [criteriaDraft, setCriteriaDraft] = useState('')

  const missionsQuery = useQuery({
    queryKey: MISSIONS_QUERY_KEY,
    queryFn: fetchMissions,
    refetchInterval: 30_000,
  })
  const missions = missionsQuery.data?.missions ?? []

  const [activeMissionKey, setActiveMissionKey] = useState<string | null>(activeId)
  useEffect(() => {
    if (activeId) setActiveMissionKey(activeId)
  }, [activeId])

  const activeMission: MissionSummary | null = useMemo(() => {
    if (missions.length === 0) return null
    if (activeMissionKey) {
      return (
        missions.find((t) => t.missionId === activeMissionKey) ?? null
      )
    }
    return missions[0] ?? null
  }, [missions, activeMissionKey])

  const detailKey = activeMission?.missionId ?? null
  const detailQuery = useQuery({
    queryKey: ['mission-control', 'mission', detailKey],
    queryFn: () => fetchMissionDetail(detailKey!),
    enabled: Boolean(detailKey),
  })

  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: fetchProjects,
  })
  const agentsQuery = useQuery({
    queryKey: ['mission-control', 'agents-status'],
    queryFn: fetchAgentsStatus,
  })

  const detail: MissionDetail | undefined = detailQuery.data
  const missionView = detail?.mission ?? activeMission
  const stages = detail?.pipeline?.stages ?? []
  const tasks = detail?.tasks ?? []
  const currentStage =
    stages.find(
      (s) =>
        s.state === 'dispatched' ||
        s.state === 'running' ||
        s.state === 'blocked',
    ) ??
    stages.find((s) => s.state === 'queued') ??
    null

  const labelsKey = (missionView?.labels ?? []).join(',')
  useEffect(() => {
    setLabelsDraft(labelsKey)
  }, [missionView?.missionId, labelsKey])

  const detailTitle = detail?.task?.title ?? missionView?.title ?? ''
  const detailSpec = detail?.task?.spec ?? ''
  const detailCriteria = (detail?.task?.acceptanceCriteria ?? []).join('\n')
  useEffect(() => {
    setTitleDraft(detailTitle)
    setSpecDraft(detailSpec)
    setCriteriaDraft(detailCriteria)
  }, [missionView?.missionId, detailTitle, detailSpec, detailCriteria])

  const specDirty =
    specDraft !== detailSpec || criteriaDraft !== detailCriteria

  const invalidateMission = () => {
    void queryClient.invalidateQueries({
      queryKey: ['mission-control', 'mission', detailKey],
    })
    void queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY })
  }

  const startMutation = useMutation({
    mutationFn: () => startMission(activeMission!.missionId!),
    onSuccess: () => {
      invalidateMission()
      toast('Mission continued', { type: 'success' })
    },
    onError: (error: Error) => {
      toast(error.message || 'Failed to start', { type: 'error' })
    },
  })

  const patchMutation = useMutation({
    mutationFn: (patch: Parameters<typeof patchMission>[1]) =>
      patchMission(detailKey!, patch),
    onSuccess: () => {
      invalidateMission()
    },
    onError: (error: Error) => {
      toast(error.message || 'Failed to update', { type: 'error' })
    },
  })

  const saveDescription = () => {
    if (!detailKey || !specDirty) return
    const acceptanceCriteria = criteriaDraft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    patchMutation.mutate(
      {
        spec: specDraft,
        acceptanceCriteria,
      },
      {
        onSuccess: () => {
          toast('Mission updated', { type: 'success' })
        },
      },
    )
  }

  const deleteMutation = useMutation({
    mutationFn: () => deleteMission(detailKey!),
    onSuccess: async () => {
      const deletedId = detailKey
      const idx = missions.findIndex((m) => m.missionId === deletedId)
      const remaining = missions.filter(
        (m) => m.missionId && m.missionId !== deletedId,
      )
      // Prefer the next row; if we deleted the last, stay on the previous.
      const nextId =
        remaining.length === 0
          ? null
          : (remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]
              ?.missionId ?? null)

      if (deletedId) {
        queryClient.removeQueries({
          queryKey: ['mission-control', 'mission', deletedId],
        })
      }
      await queryClient.invalidateQueries({ queryKey: MISSIONS_QUERY_KEY })

      if (nextId) {
        setActiveMissionKey(nextId)
        select(nextId)
      } else {
        setActiveMissionKey(null)
        select(null)
      }
      toast('Mission deleted', { type: 'success' })
    },
    onError: (error: Error) => {
      const timedOut =
        error.name === 'TimeoutError' ||
        /aborted|timeout/i.test(error.message)
      toast(
        timedOut
          ? 'Delete timed out — workspace may be stuck; restart pnpm dev'
          : error.message || 'Failed to delete',
        { type: 'error' },
      )
    },
  })

  const roomId = detail?.mission.roomId ?? activeMission?.roomId
  const missionIdForRoom =
    detail?.mission.missionId ?? activeMission?.missionId
  const nowWorker =
    missionView?.currentAssignee ??
    (currentStage ? currentStage.agent : null)
  // Prefer assignment stageKey; do not fall back to agent — that produced
  // "developer · developer" for Swarm2 / pre-pipeline missions with null stageKey.
  const nowStage =
    currentStage?.stageKey ?? missionView?.currentStage ?? null
  const agentOptions = agentsQuery.data?.agents.map((a) => a.agentId) ?? []

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-[var(--theme-border)] bg-[var(--theme-card)] p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
          Missions
        </h2>
        {missions.map((m) => (
          <button
            key={m.missionId}
            type="button"
            onClick={() => {
              const id = m.missionId
              if (!id) return
              setActiveMissionKey(id)
              select(id)
            }}
            className={cn(
              'mb-1 w-full rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
              activeMission?.missionId === m.missionId
                ? 'bg-[var(--theme-accent)] text-white'
                : 'hover:bg-[var(--theme-hover)]',
            )}
          >
            <div className="break-words font-medium">{m.title}</div>
            <div
              className={cn(
                'mt-0.5 text-[10px]',
                activeMission?.missionId === m.missionId
                  ? 'text-white/70'
                  : 'text-[var(--theme-muted)]',
              )}
            >
              {m.currentAssignee
                ? `${m.currentAssignee} · `
                : ''}
              {m.taskCount} tasks
            </div>
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--theme-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const next = titleDraft.trim()
                if (!next || !detailKey || next === detailTitle.trim()) return
                patchMutation.mutate({ title: next })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              disabled={!detailKey || patchMutation.isPending}
              className="w-full break-words rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold outline-none hover:border-[var(--theme-border)] focus:border-[var(--theme-border)] focus:bg-[var(--theme-bg)]"
              aria-label="Mission title"
            />
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {activeMission?.executionMode ? (
                <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-medium capitalize text-slate-600">
                  {activeMission.executionMode}
                </span>
              ) : null}
              {activeMission?.pipelineId ? (
                <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-700">
                  {activeMission.pipelineId}
                </span>
              ) : null}
              {nowWorker ? (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                  {nowWorker}
                  {nowStage && nowStage !== nowWorker ? ` · ${nowStage}` : ''}
                </span>
              ) : (
                <span className="rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-600">
                  No active worker
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              disabled={
                startMutation.isPending ||
                !stages.some((s) => s.state === 'queued')
              }
              onClick={() => startMutation.mutate()}
              className="text-xs"
            >
              {startMutation.isPending ? 'Starting…' : 'Start / Continue'}
            </Button>
            {missionIdForRoom ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={roomBusy}
                onClick={async () => {
                  setRoomBusy(true)
                  try {
                    const result = await createRoomFromMission(missionIdForRoom)
                    if (result.room.id) {
                      invalidateMission()
                      navigate({
                        to: '/group-chat/$roomId',
                        params: { roomId: result.room.id },
                      })
                    }
                  } finally {
                    setRoomBusy(false)
                  }
                }}
                className="text-xs"
              >
                {roomBusy
                  ? 'Opening…'
                  : roomId
                    ? 'Enter room'
                    : 'Create room'}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending || !detailKey}
              onClick={() => {
                if (
                  !window.confirm(
                    `Delete mission “${activeMission?.title ?? detailKey}”? This cannot be undone.`,
                  )
                ) {
                  return
                }
                deleteMutation.mutate()
              }}
              className="text-xs"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            <section className="mb-6 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
                  Description
                </h3>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    !detailKey || !specDirty || patchMutation.isPending
                  }
                  onClick={saveDescription}
                  className="h-7 text-[10px]"
                >
                  {patchMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
              <label className="block text-xs">
                <span className="text-[var(--theme-muted)]">Spec</span>
                <SpecField
                  value={specDraft}
                  onChange={setSpecDraft}
                  rows={5}
                  className="mt-1"
                  disabled={!detailKey}
                  placeholder="Mission description. Attach workspace paths as needed."
                />
              </label>
              <label className="mt-3 block text-xs">
                <span className="text-[var(--theme-muted)]">
                  Acceptance criteria (one per line)
                </span>
                <textarea
                  value={criteriaDraft}
                  onChange={(e) => setCriteriaDraft(e.target.value)}
                  rows={2}
                  disabled={!detailKey}
                  className="mt-1 w-full rounded-md field-surface px-2 py-1.5 text-sm disabled:opacity-50"
                />
              </label>
              {detail?.pipeline &&
              detail.pipeline.specVersion > 1 &&
              stages.some((s) => s.stale) ? (
                <p className="mt-2 text-[10px] text-amber-700">
                  Spec changed (v{detail.pipeline.specVersion}). Some stage
                  briefs are stale until regenerated.
                </p>
              ) : null}
            </section>
            {stages.length > 0 ? (
              <StageBar
                stages={stages}
                currentStageId={currentStage?.assignmentId ?? null}
              />
            ) : null}
            <h3 className="mb-2 mt-2 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
              Tasks
            </h3>
            <TasksTable tasks={tasks} />
            <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
              Timeline
            </h3>
            <Timeline
              runs={detail?.runs ?? []}
              events={detail?.events ?? []}
            />
          </div>

          <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-[var(--theme-border)] p-3 lg:block">
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
              Properties
            </h3>
            <dl className="space-y-3">
              <PropRow label="Status">
                <span className="block pt-1.5 font-medium">
                  {missionView?.status ?? '—'}
                </span>
              </PropRow>
              <PropRow label="Now">
                <span className="block break-words pt-1.5 font-medium">
                  {nowWorker ?? '—'}
                  {nowStage ? ` (${nowStage})` : ''}
                </span>
              </PropRow>
              <PropRow label="Assignee">
                {missionView?.executionMode === 'assignee' ? (
                  <select
                    className={selectClassName()}
                    disabled={patchMutation.isPending || !detailKey}
                    value={
                      missionView.assignee
                        ? `${missionView.assignee.type}:${missionView.assignee.id}`
                        : ''
                    }
                    onChange={(e) => {
                      const value = e.target.value
                      if (!value) {
                        patchMutation.mutate({ assignee: null })
                        return
                      }
                      const [type, ...rest] = value.split(':')
                      const id = rest.join(':')
                      if (type !== 'agent' && type !== 'chat_group') return
                      patchMutation.mutate({
                        assignee: { type, id },
                      })
                    }}
                  >
                    <option value="">Unassigned</option>
                    {agentOptions.map((id) => (
                      <option key={id} value={`agent:${id}`}>
                        agent:{id}
                      </option>
                    ))}
                    {missionView.assignee?.type === 'chat_group' ? (
                      <option
                        value={`chat_group:${missionView.assignee.id}`}
                      >
                        chat_group:{missionView.assignee.id}
                      </option>
                    ) : null}
                  </select>
                ) : (
                  <span className="block break-words pt-1.5 font-medium">
                    {missionView?.assignee
                      ? `${missionView.assignee.type}:${missionView.assignee.id}`
                      : missionView?.pipelineId
                        ? `pipeline:${missionView.pipelineId}`
                        : '—'}
                  </span>
                )}
              </PropRow>
              <PropRow label="Pipeline">
                <span className="block break-words pt-1.5 font-medium">
                  {missionView?.pipelineId ?? '—'}
                </span>
              </PropRow>
              <PropRow label="Priority">
                <select
                  className={selectClassName()}
                  disabled={patchMutation.isPending || !detailKey}
                  value={
                    missionView?.priority == null
                      ? ''
                      : String(missionView.priority)
                  }
                  onChange={(e) => {
                    const raw = e.target.value
                    patchMutation.mutate({
                      priority: raw === '' ? null : Number(raw),
                    })
                  }}
                >
                  <option value="">None</option>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      P{n}
                    </option>
                  ))}
                </select>
              </PropRow>
              <PropRow label="Labels">
                <input
                  className={fieldClassName()}
                  disabled={patchMutation.isPending || !detailKey}
                  value={labelsDraft}
                  placeholder="a, b, c"
                  onChange={(e) => setLabelsDraft(e.target.value)}
                  onBlur={() => {
                    const next = labelsDraft
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    const prev = missionView?.labels ?? []
                    if (next.join('\0') === prev.join('\0')) return
                    patchMutation.mutate({ labels: next })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                />
              </PropRow>
              <PropRow label="Project">
                <select
                  className={selectClassName()}
                  disabled={patchMutation.isPending || !detailKey}
                  value={missionView?.projectId ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    patchMutation.mutate({
                      projectId: value === '' ? null : value,
                    })
                  }}
                >
                  <option value="">None</option>
                  {(projectsQuery.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              </PropRow>
              <PropRow label="Room">
                <span className="block break-all pt-1.5 font-medium">
                  {roomId ?? '—'}
                </span>
              </PropRow>
            </dl>
          </aside>
        </div>
      </div>
    </div>
  )
}
