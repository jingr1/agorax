'use client'

import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Clock01Icon,
  Delete01Icon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { CreateJobDialog } from './create-job-dialog'
import { EditJobDialog } from './edit-job-dialog'
import type { ClaudeJob } from '@/lib/jobs-api'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import { PageShell } from '@/components/layout/page-shell'
import { Section } from '@/components/layout/section'
import { Toolbar, ToolbarSearch } from '@/components/layout/toolbar'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import {
  createJob,
  deleteJob,
  fetchJobOutput,
  fetchJobProfiles,
  fetchJobs,
  pauseJob,
  resumeJob,
  triggerJob,
  updateJob,
  buildJobMutationPayload,
} from '@/lib/jobs-api'
import {
  jobModelFieldsToCreatePayload,
  jobModelFieldsToUpdatePayload,
  type JobFormSubmitInput,
} from './job-form-types'

const QUERY_KEY = ['claude', 'jobs'] as const
const PROFILES_QUERY_KEY = ['claude', 'job-profiles'] as const

function formatNextRun(nextRun?: string | null): string {
  if (!nextRun) return '—'
  try {
    const d = new Date(nextRun)
    const now = new Date()
    const diffMs = d.getTime() - now.getTime()
    if (diffMs < 0) return 'overdue'
    if (diffMs < 60_000) return 'in < 1m'
    if (diffMs < 3_600_000) return `in ${Math.round(diffMs / 60_000)}m`
    if (diffMs < 86_400_000) return `in ${Math.round(diffMs / 3_600_000)}h`
    return d.toLocaleDateString()
  } catch {
    return nextRun
  }
}

function formatRunTimestamp(value?: string | null): string {
  if (!value) return 'Never run'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function getOutputPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 200) return normalized
  return `${normalized.slice(0, 200).trimEnd()}…`
}

function getLastRunStatus(job: ClaudeJob): {
  label: string
  color: string
} {
  if (!job.last_run_at) {
    return {
      label: 'Never run',
      color: 'var(--theme-muted)',
    }
  }
  if (job.last_run_success === true) {
    return {
      label: 'Last run succeeded',
      color: 'var(--theme-success)',
    }
  }
  if (job.last_run_success === false) {
    return {
      label: 'Last run failed',
      color: 'var(--theme-danger)',
    }
  }
  return {
    label: 'Last run unknown',
    color: 'var(--theme-muted)',
  }
}

function JobCard({
  job,
  onPause,
  onResume,
  onTrigger,
  onDelete,
  onEdit,
}: {
  job: ClaudeJob
  onPause: (id: string) => void
  onResume: (id: string) => void
  onTrigger: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (job: ClaudeJob) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isPaused = job.state === 'paused' || !job.enabled
  const isCompleted = job.state === 'completed'
  const lastRunStatus = getLastRunStatus(job)
  const outputQuery = useQuery({
    queryKey: ['claude', 'jobs', job.id, 'output'],
    queryFn: () => fetchJobOutput(job.id),
    enabled: expanded,
    staleTime: 30_000,
  })

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={cn(
        'rounded-xl border p-4 transition-colors',
        'bg-[var(--theme-card)] border-[var(--theme-border)]',
        isPaused && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                background: isPaused
                  ? 'var(--theme-muted)'
                  : isCompleted
                    ? 'var(--theme-accent)'
                    : 'var(--theme-text)',
              }}
            />
            <h3 className="truncate text-sm font-medium text-[var(--theme-text)]">
              {job.name || '(unnamed)'}
            </h3>
          </div>
          <p className="mb-2 line-clamp-2 text-xs text-[var(--theme-muted)]">
            {job.prompt}
          </p>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] text-[var(--theme-muted)]">
            {job.profile && (
              <>
                <span className="rounded-md border border-[var(--theme-border)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[var(--theme-text)]">
                  {job.profile}
                </span>
                <span>·</span>
              </>
            )}
            <span>{job.schedule_display || 'custom'}</span>
            <span>·</span>
            <span>Next: {formatNextRun(job.next_run_at)}</span>
            <span>·</span>
            <span>Last: {formatRunTimestamp(job.last_run_at)}</span>
            {job.skills && job.skills.length > 0 && (
              <>
                <span>·</span>
                <span>
                  {job.skills.length} skill{job.skills.length !== 1 ? 's' : ''}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[var(--theme-muted)]">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: lastRunStatus.color }}
            />
            <span>{lastRunStatus.label}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => onTrigger(job.id)}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--theme-hover)]"
            title="Run now"
          >
            <HugeiconsIcon
              icon={PlayIcon}
              size={14}
              className="text-[var(--theme-accent)]"
            />
          </button>
          <button
            onClick={() => (isPaused ? onResume(job.id) : onPause(job.id))}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--theme-hover)]"
            title={isPaused ? 'Resume' : 'Pause'}
          >
            <HugeiconsIcon
              icon={isPaused ? PlayIcon : PauseIcon}
              size={14}
              className="text-[var(--theme-muted)]"
            />
          </button>
          <button
            onClick={() => onEdit(job)}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--theme-hover)]"
            title="Edit"
          >
            <HugeiconsIcon
              icon={PencilEdit02Icon}
              size={14}
              className="text-[var(--theme-muted)]"
            />
          </button>
          <button
            onClick={() => setExpanded((current) => !current)}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--theme-hover)]"
            title={expanded ? 'Hide run history' : 'Show run history'}
          >
            <HugeiconsIcon
              icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
              size={14}
              className="text-[var(--theme-muted)]"
            />
          </button>
          <button
            onClick={() => onDelete(job.id)}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--theme-hover)]"
            title="Delete"
          >
            <HugeiconsIcon
              icon={Delete01Icon}
              size={14}
              style={{ color: 'var(--theme-danger)' }}
            />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 border-t border-[var(--theme-border)] pt-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium text-[var(--theme-text)]">
                  Run history
                </p>
                <p className="text-[10px] text-[var(--theme-muted)]">
                  Showing recent outputs
                </p>
              </div>
              {outputQuery.isLoading ? (
                <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3 text-xs text-[var(--theme-muted)]">
                  Loading outputs...
                </div>
              ) : outputQuery.isError ? (
                <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3 text-xs text-[var(--theme-muted)]">
                  Failed to load outputs.
                </div>
              ) : outputQuery.data && outputQuery.data.length > 0 ? (
                <div className="space-y-2">
                  {outputQuery.data.map((output) => (
                    <div
                      key={`${output.filename}-${output.timestamp}`}
                      className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--theme-muted)]">
                        <span>{formatRunTimestamp(output.timestamp)}</span>
                        <span className="truncate">{output.filename}</span>
                      </div>
                      <p className="text-xs leading-5 text-[var(--theme-text)]">
                        {getOutputPreview(output.content) ||
                          'No output content'}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-3 text-xs text-[var(--theme-muted)]">
                  No run outputs yet.
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}

export function JobsScreen() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [editingJob, setEditingJob] = useState<ClaudeJob | null>(null)

  const jobsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchJobs,
    refetchInterval: 30_000,
  })
  const profilesQuery = useQuery({
    queryKey: PROFILES_QUERY_KEY,
    queryFn: fetchJobProfiles,
    staleTime: 60_000,
  })
  const profiles = useMemo(
    () =>
      profilesQuery.data?.length
        ? profilesQuery.data
        : [{ name: 'default', active: true }],
    [profilesQuery.data],
  )

  const pauseMutation = useMutation({
    mutationFn: pauseJob,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast('Job paused')
    },
  })
  const resumeMutation = useMutation({
    mutationFn: resumeJob,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast('Job resumed')
    },
  })
  const triggerMutation = useMutation({
    mutationFn: triggerJob,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast('Job triggered')
    },
  })
  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast('Job deleted')
    },
  })
  const createMutation = useMutation({
    mutationFn: (input: JobFormSubmitInput) =>
      createJob({
        ...buildJobMutationPayload(input),
        profile: input.profile,
        ...jobModelFieldsToCreatePayload(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast('Job created')
      setShowCreate(false)
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to create job', {
        type: 'error',
      })
    },
  })
  const updateMutation = useMutation({
    mutationFn: async (payload: {
      jobId: string
      updates: JobFormSubmitInput
    }) =>
      updateJob(payload.jobId, {
        ...buildJobMutationPayload(payload.updates),
        profile: payload.updates.profile,
        ...jobModelFieldsToUpdatePayload(payload.updates),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast('Job updated')
      setEditingJob(null)
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'Failed to update job', {
        type: 'error',
      })
    },
  })

  const filteredJobs = useMemo(() => {
    const jobs = jobsQuery.data ?? []
    if (!search.trim()) return jobs
    const q = search.toLowerCase()
    return jobs.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        j.prompt.toLowerCase().includes(q) ||
        j.profile?.toLowerCase().includes(q),
    )
  }, [jobsQuery.data, search])

  const handleCreate = useCallback(
    async (input: JobFormSubmitInput) => {
      await createMutation.mutateAsync(input)
    },
    [createMutation],
  )

  return (
    <PageShell>
      <PageHeader
        icon={Clock01Icon}
        title="Jobs"
        meta={jobsQuery.data ? jobsQuery.data.length : undefined}
        description="Scheduled cron jobs across Hermes profiles"
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
              }
              title="Refresh"
            >
              <HugeiconsIcon icon={RefreshIcon} size={16} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              New Job
            </Button>
          </>
        }
      />

      <Section className="p-3">
        <Toolbar>
          <ToolbarSearch
            placeholder="Search jobs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Toolbar>
        {profilesQuery.isError ? (
          <p className="mt-2 text-xs text-warning">
            Profile list failed to load. New jobs will default to the default
            profile until profiles refresh.
          </p>
        ) : null}
      </Section>

      <div className="space-y-2">
        {jobsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12 text-sm text-fg-muted">
            Loading jobs...
          </div>
        ) : jobsQuery.isError ? (
          <div className="flex items-center justify-center py-12 text-sm text-danger">
            Failed to load jobs:{' '}
            {jobsQuery.error instanceof Error
              ? jobsQuery.error.message
              : 'Unknown error'}
          </div>
        ) : filteredJobs.length === 0 ? (
          <EmptyState
            icon={Clock01Icon}
            title="No scheduled jobs"
            description="No cron jobs found across Hermes profiles"
          />
        ) : (
          <AnimatePresence mode="popLayout">
            {filteredJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onPause={(id) => pauseMutation.mutate(id)}
                onResume={(id) => resumeMutation.mutate(id)}
                onTrigger={(id) => triggerMutation.mutate(id)}
                onEdit={(selectedJob) => setEditingJob(selectedJob)}
                onDelete={(id) => {
                  if (confirm(`Delete job "${job.name}"?`)) {
                    deleteMutation.mutate(id)
                  }
                }}
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      <CreateJobDialog
        open={showCreate}
        profiles={profiles}
        onOpenChange={setShowCreate}
        onSubmit={handleCreate}
        isSubmitting={createMutation.isPending}
      />
      <EditJobDialog
        job={editingJob}
        open={editingJob !== null}
        profiles={profiles}
        onOpenChange={(open) => {
          if (!open) setEditingJob(null)
        }}
        onSubmit={async (updates) => {
          if (!editingJob) return
          await updateMutation.mutateAsync({
            jobId: editingJob.id,
            updates,
          })
        }}
        isSubmitting={updateMutation.isPending}
      />
    </PageShell>
  )
}
