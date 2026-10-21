'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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
import { HugeiconsIcon } from '@hugeicons/react'
import { Cancel01Icon, Settings01Icon } from '@hugeicons/core-free-icons'
import { toast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'
import { SpecField } from './components/spec-field'
import { MissionNavList } from './components/mission-nav-list'
import { STATUS_COLORS, resolveStatus } from './mission-surface'
const MISSIONS_QUERY_KEY = ['mission-control', 'missions'] as const

const HEADER_CHIP =
  'inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-[11px] text-fg-muted'
const PROJECTS_QUERY_KEY = ['mission-control', 'projects'] as const

function stateTone(state: string) {
  if (state === 'done' || state === 'checkpointed') return 'success' as const
  if (state === 'dispatched' || state === 'running') return 'warning' as const
  if (state === 'blocked' || state === 'needs_input') return 'danger' as const
  return 'muted' as const
}

const TONE_CLASS = {
  success:
    'bg-[color-mix(in_srgb,var(--theme-success)_16%,transparent)] text-[var(--theme-success)]',
  warning:
    'bg-[color-mix(in_srgb,var(--theme-warning)_16%,transparent)] text-[var(--theme-warning)]',
  danger:
    'bg-[color-mix(in_srgb,var(--theme-danger)_16%,transparent)] text-[var(--theme-danger)]',
  muted: 'bg-[var(--theme-input)] text-fg-muted',
} as const

function DetailSection({
  title,
  meta,
  action,
  children,
  flush,
}: {
  title: string
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
  flush?: boolean
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="micro-label">{title}</h3>
          {meta ? (
            <span className="truncate text-[11px] font-normal normal-case tracking-normal text-fg-muted">
              {meta}
            </span>
          ) : null}
        </div>
        {action}
      </div>
      <div className={flush ? undefined : 'p-4'}>{children}</div>
    </section>
  )
}

function StageBar({
  stages,
  currentStageId,
}: {
  stages: Array<PipelineStage>
  currentStageId: string | null
}) {
  if (stages.length < 2) return null
  return (
    <div className="flex items-center gap-1 overflow-x-auto px-4 py-3">
      {stages.map((stage, index) => {
        const isCurrent = stage.assignmentId === currentStageId
        const tone = stateTone(stage.state)
        return (
          <div key={stage.assignmentId} className="flex items-center">
            <div
              className={cn(
                'flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-medium',
                isCurrent
                  ? 'bg-[var(--theme-accent)] text-white'
                  : TONE_CLASS[tone],
              )}
            >
              {stage.stageKey ?? stage.agent}
            </div>
            {index < stages.length - 1 ? (
              <div className="mx-1.5 h-px w-4 bg-border" />
            ) : null}
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
      <p className="px-4 py-8 text-center text-[13px] text-fg-muted">
        No tasks yet. They show up when a pipeline stage or assignee starts
        work.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[13px]">
        <thead className="text-[11px] text-fg-muted">
          <tr className="border-b border-border">
            <th className="px-4 py-2 font-medium">Created by</th>
            <th className="px-4 py-2 font-medium">Worker</th>
            <th className="px-4 py-2 font-medium">Stage</th>
            <th className="px-4 py-2 font-medium">State</th>
            <th className="px-4 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const expanded = expandedId === t.id
            const summary = taskSummaryLine(t.task)
            return (
              <tr
                key={t.id}
                className="border-b border-border align-top last:border-b-0 hover:bg-[var(--transparency-hover)]"
              >
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-fg-muted">
                  {t.createdByWorkerId ?? '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-medium text-fg">
                  {t.workerId}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                  {t.stageKey ?? '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      TONE_CLASS[stateTone(t.state)],
                    )}
                  >
                    {t.state}
                  </span>
                </td>
                <td className="min-w-[12rem] px-4 py-2.5 text-fg-muted">
                  <button
                    type="button"
                    className="w-full text-left hover:text-fg"
                    onClick={() => setExpandedId(expanded ? null : t.id)}
                  >
                    <span className="block break-words">{summary}</span>
                    {expanded ? (
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-[var(--theme-bg)] p-2 text-[11px] leading-relaxed text-fg">
                        {t.task}
                      </pre>
                    ) : t.task.length > summary.length ? (
                      <span className="mt-0.5 block text-[11px] text-accent">
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

  if (items.length === 0) {
    return <p className="text-[13px] text-fg-muted">No activity yet.</p>
  }

  return (
    <ol>
      {items.map((item, index) => (
        <li key={item.id} className="flex gap-3">
          <div className="flex w-3 shrink-0 flex-col items-center">
            <span
              className={cn(
                'mt-1.5 size-1.5 rounded-full',
                index === 0
                  ? 'bg-[var(--theme-accent)]'
                  : 'bg-[color-mix(in_srgb,var(--theme-muted)_55%,transparent)]',
              )}
            />
            {index < items.length - 1 ? (
              <span className="mt-1 w-px flex-1 bg-border" />
            ) : null}
          </div>
          <div
            className={cn(
              'min-w-0 flex-1',
              index < items.length - 1 ? 'pb-4' : undefined,
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-[13px] text-fg">
                <span className="break-words">{item.title}</span>
                {item.count ? (
                  <span
                    className={cn(
                      'ml-2 rounded-full px-1.5 py-0.5 text-[10px]',
                      TONE_CLASS.muted,
                    )}
                  >
                    ×{item.count}
                  </span>
                ) : null}
              </div>
              <time className="shrink-0 pt-0.5 text-[11px] tabular-nums text-fg-muted">
                {item.at ? new Date(item.at).toLocaleTimeString() : ''}
              </time>
            </div>
            {item.subtitle ? (
              <p className="mt-0.5 break-words text-xs text-fg-muted">
                {item.subtitle}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

function PropRow({
  label,
  children,
  align = 'center',
}: {
  label: string
  children: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-[13px]',
        align === 'start' ? 'items-start' : 'items-center',
      )}
    >
      <dt className="text-[11px] text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  )
}

function selectClassName() {
  return 'control-surface h-8 w-full rounded-md px-2 text-xs'
}

function fieldClassName() {
  return 'field-surface h-8 w-full rounded-md px-2 text-xs'
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
  const [propertiesOpen, setPropertiesOpen] = useState(false)
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

  const [activeMissionKey, setActiveMissionKey] = useState<string | null>(
    activeId,
  )
  const handleNavSelect = useCallback(
    (id: string) => {
      setActiveMissionKey(id)
      select(id)
    },
    [select],
  )
  useEffect(() => {
    if (activeId) setActiveMissionKey(activeId)
  }, [activeId])

  const activeMission: MissionSummary | null = useMemo(() => {
    if (missions.length === 0) return null
    if (activeMissionKey) {
      return missions.find((t) => t.missionId === activeMissionKey) ?? null
    }
    return missions[0] ?? null
  }, [missions, activeMissionKey])

  const detailKey = activeMission?.missionId ?? null
  useEffect(() => {
    setPropertiesOpen(false)
  }, [detailKey])
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
  const openAttachRef = useRef<(() => void) | null>(null)
  const handleAttachReady = useCallback((open: (() => void) | null) => {
    openAttachRef.current = open
  }, [])
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

  const specDirty = specDraft !== detailSpec || criteriaDraft !== detailCriteria

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
      setPropertiesOpen(false)
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
        error.name === 'TimeoutError' || /aborted|timeout/i.test(error.message)
      toast(
        timedOut
          ? 'Delete timed out — workspace may be stuck; restart pnpm dev'
          : error.message || 'Failed to delete',
        { type: 'error' },
      )
    },
  })

  // chat_group assignee id is the bound room; prefer it over a stale mission.roomId
  // left by older ensureRoomForMission that created a second room.
  const roomId =
    missionView?.assignee?.type === 'chat_group' && missionView.assignee.id
      ? missionView.assignee.id
      : (detail?.mission.roomId ?? activeMission?.roomId)
  const missionIdForRoom = detail?.mission.missionId ?? activeMission?.missionId
  const nowWorker =
    missionView?.currentAssignee ?? (currentStage ? currentStage.agent : null)
  // Prefer assignment stageKey; do not fall back to agent — that produced
  // "developer · developer" for Swarm2 / pre-pipeline missions with null stageKey.
  const nowStage = currentStage?.stageKey ?? missionView?.currentStage ?? null
  const agentOptions = agentsQuery.data?.agents.map((a) => a.agentId) ?? []

  const roomButton = missionIdForRoom ? (
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
      {roomBusy ? 'Opening…' : roomId ? 'Enter room' : 'Create room'}
    </Button>
  ) : null

  const deleteButton = (
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
  )

  return (
    <div className="flex h-full min-h-0">
      <MissionNavList
        missions={missions}
        activeMissionId={activeMission?.missionId ?? null}
        onSelect={handleNavSelect}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
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
              className="field-bare -ml-1.5 w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xl font-semibold tracking-tight text-fg outline-none transition-colors hover:bg-hover focus:border-accent focus:bg-input"
              aria-label="Mission title"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {activeMission ? (
                <span className={HEADER_CHIP}>
                  <span
                    className="size-1.5 rounded-full"
                    style={{
                      background: STATUS_COLORS[resolveStatus(activeMission)],
                    }}
                  />
                  <span className="capitalize text-fg">
                    {resolveStatus(activeMission)}
                  </span>
                </span>
              ) : null}
              {nowWorker ? (
                <span className={HEADER_CHIP}>
                  <span className="size-1.5 rounded-full bg-warning" />
                  <span className="text-fg">{nowWorker}</span>
                  {nowStage && nowStage !== nowWorker ? (
                    <span>· {nowStage}</span>
                  ) : null}
                </span>
              ) : (
                <span className={HEADER_CHIP}>No active worker</span>
              )}
              {activeMission?.executionMode ? (
                <span className={cn(HEADER_CHIP, 'capitalize')}>
                  {activeMission.executionMode}
                </span>
              ) : null}
              {activeMission?.pipelineId ? (
                <span className={HEADER_CHIP} title="Pipeline">
                  {activeMission.pipelineId}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!detailKey}
              onClick={() => setPropertiesOpen(true)}
              className="text-xs"
            >
              <HugeiconsIcon icon={Settings01Icon} size={14} strokeWidth={1.8} />
              Properties
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                startMutation.isPending ||
                !stages.some((s) => s.state === 'queued')
              }
              title={
                stages.some((s) => s.state === 'queued')
                  ? undefined
                  : 'No queued stages to run'
              }
              onClick={() => startMutation.mutate()}
              className="text-xs"
            >
              {startMutation.isPending ? 'Starting…' : 'Start / Continue'}
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-5">
              <DetailSection
                title="Description"
                action={
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!detailKey}
                      onClick={() => openAttachRef.current?.()}
                      className="h-7 px-2.5 text-xs"
                    >
                      Attach path
                    </Button>
                    <Button
                      type="button"
                      variant={specDirty ? 'default' : 'secondary'}
                      size="sm"
                      disabled={
                        !detailKey || !specDirty || patchMutation.isPending
                      }
                      onClick={saveDescription}
                      className="h-7 px-2.5 text-xs"
                    >
                      {patchMutation.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                }
              >
                <SpecField
                  value={specDraft}
                  onChange={setSpecDraft}
                  rows={4}
                  disabled={!detailKey}
                  hideToolbar
                  onAttachReady={handleAttachReady}
                  placeholder="Mission description. Attach workspace paths as needed."
                />
                <label className="mt-4 block">
                  <span className="text-[11px] text-fg-muted">
                    Acceptance criteria
                    <span className="ml-1.5 text-fg-muted/70">
                      one per line
                    </span>
                  </span>
                  <textarea
                    value={criteriaDraft}
                    onChange={(e) => setCriteriaDraft(e.target.value)}
                    rows={2}
                    disabled={!detailKey}
                    className="mt-1.5 w-full rounded-lg field-surface px-3 py-2 text-sm leading-relaxed disabled:opacity-50"
                  />
                </label>
                {detail?.pipeline &&
                detail.pipeline.specVersion > 1 &&
                stages.some((s) => s.stale) ? (
                  <p className="mt-3 text-[11px] text-[var(--theme-warning)]">
                    Spec changed (v{detail.pipeline.specVersion}). Some stage
                    briefs are stale until regenerated.
                  </p>
                ) : null}
              </DetailSection>
              {stages.length > 1 ? (
                <DetailSection title="Pipeline" flush>
                  <StageBar
                    stages={stages}
                    currentStageId={currentStage?.assignmentId ?? null}
                  />
                </DetailSection>
              ) : null}
              <DetailSection
                title="Tasks"
                meta={tasks.length ? String(tasks.length) : undefined}
                flush
              >
                <TasksTable tasks={tasks} />
              </DetailSection>
              <DetailSection title="Timeline">
                <Timeline
                  runs={detail?.runs ?? []}
                  events={detail?.events ?? []}
                />
              </DetailSection>
            </div>
          </div>

          <DialogRoot open={propertiesOpen} onOpenChange={setPropertiesOpen}>
            <DialogContent className="w-[min(24rem,92vw)]">
              <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <DialogTitle className="text-sm font-semibold">
                    Properties
                  </DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs text-fg-muted">
                    Status, assignee, and project for this mission.
                  </DialogDescription>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setPropertiesOpen(false)}
                  className="rounded-md p-1 text-fg-muted hover:bg-[var(--transparency-hover)] hover:text-fg"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={16} />
                </button>
              </div>
              <div className="max-h-[min(70vh,32rem)] overflow-y-auto px-4 py-4">
                <dl className="space-y-3">
                <PropRow label="Status">
                  <span className="inline-flex items-center gap-1.5 font-medium capitalize">
                    {activeMission ? (
                      <span
                        className="size-1.5 rounded-full"
                        style={{
                          background:
                            STATUS_COLORS[resolveStatus(activeMission)],
                        }}
                      />
                    ) : null}
                    {missionView?.status ?? '—'}
                  </span>
                </PropRow>
                <PropRow label="Now">
                  <span className="block truncate font-medium">
                    {nowWorker ?? '—'}
                    {nowStage && nowStage !== nowWorker ? ` · ${nowStage}` : ''}
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
                          {id}
                        </option>
                      ))}
                      {missionView.assignee?.type === 'chat_group' ? (
                        <option value={`chat_group:${missionView.assignee.id}`}>
                          group:{missionView.assignee.id}
                        </option>
                      ) : null}
                    </select>
                  ) : (
                    <span className="block truncate font-medium">
                      {missionView?.assignee
                        ? missionView.assignee.type === 'agent'
                          ? missionView.assignee.id
                          : `${missionView.assignee.type}:${missionView.assignee.id}`
                        : missionView?.pipelineId
                          ? missionView.pipelineId
                          : '—'}
                    </span>
                  )}
                </PropRow>
                <PropRow label="Pipeline">
                  <span className="block truncate font-medium">
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
                <PropRow label="Room" align={roomId ? 'start' : 'center'}>
                  <div className={roomId ? 'space-y-1.5' : undefined}>
                    {roomId ? (
                      <span
                        className="block truncate font-mono text-[11px]"
                        title={roomId}
                      >
                        {roomId}
                      </span>
                    ) : null}
                    {roomButton}
                  </div>
                </PropRow>
              </dl>
              </div>
              <div className="shrink-0 border-t border-border px-4 py-3 [&>button]:w-full">
                {deleteButton}
              </div>
            </DialogContent>
          </DialogRoot>
        </div>
      </div>
    </div>
  )
}
