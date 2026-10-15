'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import { PlusSignIcon } from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import { fetchAgentsStatus, fetchProjects } from '@/lib/mission-control-api'
import { SpecField } from './spec-field'

const PIPELINES_QUERY_KEY = ['mission-control', 'pipelines'] as const
const ROOMS_QUERY_KEY = ['mission-control', 'rooms'] as const

type ExecutionMode = 'goal' | 'pipeline' | 'assignee'
type AssigneeKind = 'agent' | 'chat_group'

async function fetchPipelines(): Promise<
  Array<{ id: string; name: string; stages: number }>
> {
  const res = await fetch('/api/pipelines')
  if (!res.ok) throw new Error(`Failed to fetch pipelines: ${res.status}`)
  const data = (await res.json()) as {
    pipelines?: Array<{ id: string; name: string; stages: number }>
    error?: string
  }
  if (data.error) throw new Error(data.error)
  return data.pipelines ?? []
}

async function fetchRooms(): Promise<Array<{ id: string; title: string }>> {
  const res = await fetch('/api/rooms')
  if (!res.ok) return []
  const data = (await res.json()) as {
    rooms?: Array<{ id: string; title: string }>
  }
  return data.rooms ?? []
}

async function createMission(payload: Record<string, unknown>): Promise<{
  missionId?: string | null
  roomId?: string | null
}> {
  const res = await fetch('/api/missions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    missionId?: string | null
    roomId?: string | null
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `Failed to create mission: ${res.status}`)
  }
  return data
}

function titleFromGoal(goal: string): string {
  const line = goal.trim().split(/\r?\n/).find((l) => l.trim()) ?? ''
  const clipped = line.trim().slice(0, 120)
  return clipped || 'Untitled mission'
}

type CreateMissionButtonProps = {
  variant?: 'header' | 'inline'
}

export function CreateMissionButton({
  variant = 'header',
}: CreateMissionButtonProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  const [criteria, setCriteria] = useState('')
  const [mode, setMode] = useState<ExecutionMode>('goal')
  const [selectedPipelineId, setSelectedPipelineId] = useState('')
  const [assigneeKind, setAssigneeKind] = useState<AssigneeKind>('agent')
  const [assigneeId, setAssigneeId] = useState('')
  const [autoDispatch, setAutoDispatch] = useState(true)
  const [projectId, setProjectId] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const pipelinesQuery = useQuery({
    queryKey: PIPELINES_QUERY_KEY,
    queryFn: fetchPipelines,
    enabled: open && mode === 'pipeline',
  })
  const projectsQuery = useQuery({
    queryKey: ['mission-control', 'projects'],
    queryFn: fetchProjects,
    enabled: open,
  })
  const agentsQuery = useQuery({
    queryKey: ['mission-control', 'agents-status'],
    queryFn: fetchAgentsStatus,
    enabled: open && mode === 'assignee' && assigneeKind === 'agent',
  })
  const roomsQuery = useQuery({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: fetchRooms,
    enabled: open && mode === 'assignee' && assigneeKind === 'chat_group',
  })

  const agentOptions = useMemo(
    () => agentsQuery.data?.agents.map((a) => a.agentId) ?? [],
    [agentsQuery.data],
  )

  const mutation = useMutation({
    mutationFn: async () => {
      const acceptanceCriteria = criteria
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const project = projectId.trim() || undefined
      if (mode === 'goal') {
        const goal = spec.trim()
        if (!goal) throw new Error('Enter a goal')
        return createMission({
          title: titleFromGoal(goal),
          spec: goal,
          executionMode: 'assignee',
          assignee: { type: 'agent', id: 'orchestrator' },
          acceptanceCriteria,
          autoDispatch: true,
          projectId: project,
        })
      }
      if (mode === 'pipeline') {
        if (!selectedPipelineId) throw new Error('Select a pipeline')
        return createMission({
          title,
          spec,
          executionMode: 'pipeline',
          pipelineId: selectedPipelineId,
          acceptanceCriteria,
          autoDispatch,
          projectId: project,
        })
      }
      if (!assigneeId) throw new Error('Select an assignee')
      return createMission({
        title,
        spec,
        executionMode: 'assignee',
        assignee: { type: assigneeKind, id: assigneeId },
        acceptanceCriteria,
        autoDispatch: assigneeKind === 'agent' ? autoDispatch : false,
        projectId: project,
      })
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: ['mission-control', 'tasks'],
      })
      void queryClient.invalidateQueries({
        queryKey: ['mission-control', 'missions'],
      })
      toast(
        mode === 'goal'
          ? 'Mission launched via orchestrator'
          : 'Mission created',
        { type: 'success' },
      )
      setOpen(false)
      setTitle('')
      setSpec('')
      setCriteria('')
      setProjectId('')
      const id = data.missionId
      if (id) {
        void navigate({
          to: '/missions',
          search: { missionId: id },
        })
      }
    },
    onError: (error: Error) => {
      toast(error.message || 'Failed to create mission', { type: 'error' })
    },
  })

  const submitDisabled =
    mutation.isPending ||
    (mode === 'goal' ? !spec.trim() : !title.trim())

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn('text-xs', variant === 'inline' && 'w-full')}
      >
        <HugeiconsIcon icon={PlusSignIcon} size={14} />
        Create Mission
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] p-4 shadow-xl">
            <h2 className="text-sm font-semibold">Create Mission</h2>
            <p className="mt-1 text-[11px] text-[var(--theme-muted)]">
              Goal launches orchestrator routing. Pipeline runs a fixed stage
              graph. Assignee targets one agent or chat group.
            </p>

            <div className="mt-3 flex gap-1 rounded-lg bg-[var(--theme-input)] p-0.5">
              {(
                [
                  ['goal', 'Goal'],
                  ['pipeline', 'Pipeline'],
                  ['assignee', 'Assignee'],
                ] as const
              ).map(([m, label]) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? 'default' : 'ghost'}
                  onClick={() => setMode(m)}
                  className="flex-1 text-xs"
                >
                  {label}
                </Button>
              ))}
            </div>

            <div className="mt-3 space-y-3">
              {mode === 'goal' ? (
                <label className="block text-xs">
                  <span className="text-[var(--theme-muted)]">Goal</span>
                  <SpecField
                    value={spec}
                    onChange={setSpec}
                    rows={5}
                    className="mt-1"
                    placeholder="Describe the outcome. Orchestrator decomposes and dispatches specialists."
                  />
                </label>
              ) : (
                <>
                  <label className="block text-xs">
                    <span className="text-[var(--theme-muted)]">Title</span>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="mt-1 w-full rounded-md field-surface px-2 py-1.5 text-sm"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="text-[var(--theme-muted)]">Spec</span>
                    <SpecField
                      value={spec}
                      onChange={setSpec}
                      rows={4}
                      className="mt-1"
                      placeholder="Describe the mission. Attach workspace paths as needed."
                    />
                  </label>
                </>
              )}

              {mode !== 'goal' ? (
                <label className="block text-xs">
                  <span className="text-[var(--theme-muted)]">
                    Acceptance criteria (one per line)
                  </span>
                  <textarea
                    value={criteria}
                    onChange={(e) => setCriteria(e.target.value)}
                    rows={2}
                    className="mt-1 w-full rounded-md field-surface px-2 py-1.5 text-sm"
                  />
                </label>
              ) : null}

              {mode === 'pipeline' ? (
                <label className="block text-xs">
                  <span className="text-[var(--theme-muted)]">Pipeline</span>
                  <select
                    value={selectedPipelineId}
                    onChange={(e) => setSelectedPipelineId(e.target.value)}
                    className="mt-1 w-full control-surface rounded-md px-2 py-1.5 text-sm"
                  >
                    <option value="">Select…</option>
                    {(pipelinesQuery.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.stages} stages)
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {mode === 'assignee' ? (
                <div className="space-y-2">
                  <div className="flex gap-1 rounded-lg bg-[var(--theme-input)] p-0.5">
                    {(['agent', 'chat_group'] as const).map((k) => (
                      <Button
                        key={k}
                        type="button"
                        size="sm"
                        variant={assigneeKind === k ? 'secondary' : 'ghost'}
                        onClick={() => {
                          setAssigneeKind(k)
                          setAssigneeId('')
                        }}
                        className="flex-1 text-[11px]"
                      >
                        {k === 'agent' ? 'Agent' : 'Chat group'}
                      </Button>
                    ))}
                  </div>
                  <label className="block text-xs">
                    <span className="text-[var(--theme-muted)]">Assignee</span>
                    <select
                      value={assigneeId}
                      onChange={(e) => setAssigneeId(e.target.value)}
                      className="mt-1 w-full control-surface rounded-md px-2 py-1.5 text-sm"
                    >
                      <option value="">Select…</option>
                      {assigneeKind === 'agent'
                        ? agentOptions.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))
                        : (roomsQuery.data ?? []).map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.title || r.id}
                            </option>
                          ))}
                    </select>
                  </label>
                </div>
              ) : null}

              {(mode === 'pipeline' ||
                (mode === 'assignee' && assigneeKind === 'agent')) && (
                <label className="flex items-center gap-2 text-xs text-[var(--theme-muted)]">
                  <input
                    type="checkbox"
                    checked={autoDispatch}
                    onChange={(e) => setAutoDispatch(e.target.checked)}
                  />
                  Auto-start tasks
                </label>
              )}

              {mode === 'goal' ? (
                <p className="text-[11px] text-[var(--theme-muted)]">
                  Assigns <code className="text-[10px]">orchestrator</code> and
                  auto-starts. Specialists are dispatched onto this mission via{' '}
                  <code className="text-[10px]">/api/swarm-dispatch</code>.
                </p>
              ) : null}

              <label className="block text-xs">
                <span className="text-[var(--theme-muted)]">
                  Project (optional)
                </span>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="mt-1 w-full control-surface rounded-md px-2 py-1.5 text-sm"
                >
                  <option value="">None</option>
                  {(projectsQuery.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setOpen(false)}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={submitDisabled}
                onClick={() => mutation.mutate()}
                className="text-xs"
              >
                {mutation.isPending
                  ? mode === 'goal'
                    ? 'Launching…'
                    : 'Creating…'
                  : mode === 'goal'
                    ? 'Launch'
                    : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** @deprecated Prefer CreateMissionButton */
export const CreateTaskButton = CreateMissionButton
