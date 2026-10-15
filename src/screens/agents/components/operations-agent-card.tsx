import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight01Icon,
  Clock01Icon,
  PlayIcon,
  Settings01Icon,
  Chatting01Icon,
  Folder01Icon,
  PuzzleIcon,
  Link01Icon,
  RefreshIcon,
  AlertCircleIcon,
  Target02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { AgentProgress } from '@/components/agent-view/agent-progress'
import { AgentIdentityAvatar } from '@/components/avatars'
import { Markdown } from '@/components/prompt-kit/markdown'
import { toast } from '@/components/ui/toast'
import { runCronJob, toggleCronJob } from '@/lib/cron-api'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import { cn } from '@/lib/utils'
import {
  useAgentChat,
  type OperationsChatMessage,
} from '../hooks/use-agent-chat'
import type { OperationsAgent } from '../hooks/use-operations'

/**
 * Dot = availability (+ gate overrides). Label folds workload like Multica
 * chips ("Online · Working") so Chat and Operations stay aligned.
 */
function getStatusStyles(agent: OperationsAgent) {
  if (agent.needsSetup || agent.status === 'needsSetup') {
    return {
      dot: 'bg-amber-400',
      ring: 'text-amber-400',
      label: 'Needs setup',
      border: 'border-amber-300/40',
      pulse: false,
    }
  }

  if (agent.availability === 'offline' || agent.status === 'offline') {
    return {
      dot: 'bg-neutral-400',
      ring: 'text-neutral-400',
      label: 'Offline',
      border: 'border-neutral-300/30',
      pulse: false,
    }
  }

  if (agent.status === 'blocked' || agent.needsHuman) {
    return {
      dot: 'bg-rose-500',
      ring: 'text-rose-500',
      label: 'Blocked',
      border: 'border-rose-300/30',
      pulse: false,
    }
  }

  if (agent.status === 'error') {
    return {
      dot: 'bg-red-500',
      ring: 'text-red-500',
      label: 'Error',
      border: 'border-red-300/30',
      pulse: false,
    }
  }

  if (agent.availability === 'unstable') {
    return {
      dot: 'bg-amber-500',
      ring: 'text-amber-500',
      label:
        agent.workload === 'working'
          ? 'Unstable · Working'
          : agent.workload === 'queued'
            ? 'Unstable · Queued'
            : 'Unstable',
      border: 'border-amber-300/40',
      pulse: agent.workload === 'working',
    }
  }

  // online
  return {
    dot: 'bg-emerald-500',
    ring: 'text-emerald-500',
    label:
      agent.workload === 'working'
        ? 'Online · Working'
        : agent.workload === 'queued'
          ? 'Online · Queued'
          : 'Online',
    border: 'border-emerald-300/30',
    pulse: agent.workload === 'working',
  }
}

function stripEmojiPrefix(value: string) {
  return value
    .replace(
      /^((\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*)\s*/u,
      '',
    )
    .trim()
}

function displayJobName(jobName: string, agentId: string) {
  const prefix = `ops:${agentId}:`
  if (jobName.startsWith(prefix)) {
    return jobName.slice(prefix.length).replace(/-/g, ' ')
  }
  return jobName
}

function describeJob(job: OperationsAgent['jobs'][number]) {
  return job.description?.trim() || job.schedule
}

function formatShortPath(path?: string): string {
  if (!path) return 'No workspace'
  const trimmed = path.replace(/\\/g, '/')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return 'No workspace'
  if (parts.length <= 2) return `/${parts.join('/')}`
  return `.../${parts.slice(-2).join('/')}`
}

function formatModelLabel(agent: OperationsAgent): string {
  if (!agent.model) return 'No model'
  const provider = agent.provider || agent.model.split('/')[0] || 'model'
  const modelName = agent.model.includes('/')
    ? agent.model.slice(agent.model.indexOf('/') + 1)
    : agent.model
  return `${provider} / ${modelName}`
}

export function OperationsInlineChat({
  agentName,
  messages,
  sendMessage,
  isSending,
  error,
}: {
  agentName: string
  messages: OperationsChatMessage[]
  sendMessage: (message: string) => Promise<unknown>
  isSending: boolean
  error: string | null
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const renderedMessages = useMemo(() => messages.slice(-50), [messages])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [renderedMessages])

  async function handleSend() {
    const message = draft.trim()
    if (!message || isSending) return
    await sendMessage(message)
    setDraft('')
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-[1.25rem] border border-[var(--theme-border)] bg-[var(--theme-card)]">
      <div
        ref={scrollRef}
        className="flex min-h-[100px] max-h-[160px] flex-1 flex-col justify-center overflow-y-auto px-3 py-3"
      >
        {renderedMessages.length > 0 ? (
          <div className="space-y-2">
            {renderedMessages.map((message) => {
              const isUser = message.role === 'user'

              return (
                <div
                  key={message.id}
                  className={cn(
                    'flex',
                    isUser ? 'justify-end' : 'justify-start',
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[92%] rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-sm',
                      isUser
                        ? 'bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                        : 'bg-[var(--theme-card2)] text-[var(--theme-text)]',
                    )}
                  >
                    {message.role === 'assistant' ? (
                      <Markdown>{message.content}</Markdown>
                    ) : (
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-center text-xs text-[var(--theme-muted)]">
            Send a message...
          </p>
        )}
      </div>

      <div className="border-t border-[var(--theme-border)] px-3 py-3">
        {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}
        <div className="flex items-center gap-2 rounded-[1rem] border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                void handleSend()
              }
            }}
            placeholder={`Message ${stripEmojiPrefix(agentName)}...`}
            className="h-8 flex-1 bg-transparent px-1.5 text-xs text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)]"
          />
          <Button
            size="icon-sm"
            className="rounded-lg bg-[var(--theme-accent)] text-primary-950 hover:bg-[var(--theme-accent-strong)]"
            onClick={() => void handleSend()}
            disabled={!draft.trim() || isSending}
            aria-label={isSending ? 'Sending message' : 'Send message'}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={15}
              strokeWidth={1.8}
            />
          </Button>
        </div>
      </div>
    </section>
  )
}

export function OperationsAgentCard({
  agent,
  onOpenSettings,
  providerSiblingCount = 1,
}: {
  agent: OperationsAgent
  onOpenSettings: (agentId: string) => void
  /** Hermes roster size — >1 shows two-letter initials on the circular icon. */
  providerSiblingCount?: number
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const status = getStatusStyles(agent)
  const displayName = stripEmojiPrefix(agent.name)
  const [showCronPanel, setShowCronPanel] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const { messages, sendMessage, isSending, error } = useAgentChat(
    agent.sessionKey,
  )
  const cronJobCount = agent.jobs.length

  function openCurrentMission() {
    if (agent.missionId) {
      void navigate({
        to: '/missions',
        search: { missionId: agent.missionId },
      })
      return
    }
    void navigate({ to: '/missions' })
  }

  const toggleMutation = useMutation({
    mutationFn: async (payload: { jobId: string; enabled: boolean }) =>
      toggleCronJob(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['operations', 'cron'] })
    },
    onError: (mutationError) => {
      toast(
        mutationError instanceof Error
          ? mutationError.message
          : 'Failed to update cron job',
        { type: 'error' },
      )
    },
  })

  const runCronMutation = useMutation({
    mutationFn: async (jobId: string) => runCronJob(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['operations', 'cron'] })
      toast('Cron job started', { type: 'success' })
    },
    onError: (mutationError) => {
      toast(
        mutationError instanceof Error
          ? mutationError.message
          : 'Failed to run cron job',
        { type: 'error' },
      )
    },
  })

  async function handleRunTask() {
    if (agent.needsSetup) {
      onOpenSettings(agent.id)
      return
    }
    await sendMessage('Run your primary task now')
    setShowChat(true)
    toast('Task started', { type: 'success' })
  }

  const isBlocked = agent.runtimeState === 'blocked' || agent.needsHuman

  const [recovering, setRecovering] = useState(false)

  async function handleRecover() {
    setRecovering(true)
    try {
      // Step 1: Stop the tmux session (kills old TUI + clears runtime.json)
      const stopRes = await fetch('/api/swarm-tmux-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: agent.id }),
      })
      const stopPayload = (await stopRes.json()) as { error?: string }
      if (!stopRes.ok) {
        throw new Error(
          stopPayload.error || `Stop failed: HTTP ${stopRes.status}`,
        )
      }

      // Step 2: Start a fresh tmux session (loads latest config.yaml)
      const startRes = await fetch('/api/swarm-tmux-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: agent.id }),
      })
      const startPayload = (await startRes.json()) as {
        error?: string
        started?: boolean
        alreadyRunning?: boolean
      }
      if (!startRes.ok) {
        throw new Error(
          startPayload.error || `Start failed: HTTP ${startRes.status}`,
        )
      }

      toast(`${agent.id} restarted successfully`, { type: 'success' })
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'swarm-runtime'],
      })
      await queryClient.invalidateQueries({
        queryKey: ['operations', 'sessions'],
      })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to recover', {
        type: 'error',
      })
    } finally {
      setRecovering(false)
    }
  }

  const latestOutput = agent.recentOutputs[0]

  return (
    <article
      className={cn(
        'group flex min-h-[20rem] flex-col rounded-[1.5rem] border bg-[var(--theme-card)] p-3 shadow-[0_20px_60px_color-mix(in_srgb,var(--theme-shadow)_14%,transparent)] transition-all',
        status.border,
        agent.needsSetup && 'bg-amber-300/5',
      )}
    >
      {/* Header toolbar */}
      <div className="relative flex min-h-8 items-center">
        <div className="absolute left-0 flex items-center">
          <button
            type="button"
            aria-label={
              cronJobCount > 0
                ? `${cronJobCount} cron jobs for ${displayName}`
                : `No cron jobs for ${displayName}`
            }
            onClick={() => setShowCronPanel((value) => !value)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[var(--theme-muted)] transition-colors hover:bg-[var(--theme-bg)] hover:text-[var(--theme-text)]',
              showCronPanel && 'bg-[var(--theme-bg)] text-[var(--theme-text)]',
            )}
          >
            <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.9} />
            {cronJobCount > 0 ? (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--theme-bg)] px-1.5 text-[10px] font-medium text-[var(--theme-text)]">
                {cronJobCount}
              </span>
            ) : null}
          </button>
        </div>

        <div className="flex w-full justify-center px-20">
          <button
            type="button"
            onClick={() => onOpenSettings(agent.id)}
            className="min-w-0 text-center text-sm font-semibold text-[var(--theme-text)] hover:text-[var(--theme-accent-strong)]"
          >
            <span className="inline-flex max-w-full items-center justify-center gap-2">
              <span className="truncate">{displayName}</span>
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  status.pulse && 'animate-pulse',
                  status.dot,
                )}
                aria-label={status.label}
                title={status.label}
              />
            </span>
          </button>
        </div>

        <div className="absolute right-0 flex items-center gap-1">
          <button
            type="button"
            aria-label={
              agent.needsSetup
                ? `Configure ${displayName} before running`
                : `Run ${displayName} now`
            }
            onClick={() => void handleRunTask()}
            disabled={isSending}
            title={
              agent.needsSetup
                ? 'No model configured — open settings to set one up'
                : 'Run primary task'
            }
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--theme-bg)] disabled:cursor-not-allowed disabled:opacity-60',
              agent.needsSetup
                ? 'text-amber-300 hover:text-amber-200'
                : 'text-[var(--theme-muted)] hover:text-[var(--theme-text)]',
            )}
          >
            <HugeiconsIcon icon={PlayIcon} size={16} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            aria-label={`Open settings for ${displayName}`}
            onClick={() => onOpenSettings(agent.id)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--theme-muted)] transition-colors hover:bg-[var(--theme-bg)] hover:text-[var(--theme-text)]"
          >
            <HugeiconsIcon icon={Settings01Icon} size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* Identity section */}
      <button
        type="button"
        onClick={() => onOpenSettings(agent.id)}
        className="flex flex-col items-center gap-1 px-2 py-2 text-center"
      >
        <div className="relative flex size-12 shrink-0 items-center justify-center">
          <AgentProgress
            value={agent.progressValue}
            status={agent.progressStatus}
            size={48}
            strokeWidth={2.5}
            className={status.ring}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <AgentIdentityAvatar
              name={displayName}
              runtime={agent.runtime || 'hermes'}
              providerSiblingCount={providerSiblingCount}
              size={40}
            />
          </div>
        </div>

        <p className="w-full truncate text-[11px] text-[var(--theme-muted)]">
          {agentRuntimeLabel(agent.runtime || 'hermes')}
          {agent.meta.description || agent.description
            ? ` · ${agent.meta.description || agent.description}`
            : ''}
        </p>
      </button>

      {agent.currentTask || agent.missionId ? (
        <button
          type="button"
          onClick={openCurrentMission}
          className="mx-2 mb-1 flex items-center gap-1.5 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--theme-accent)] hover:bg-[var(--theme-hover)]"
          title={
            agent.missionId ? 'Open mission pipeline' : 'Open Missions board'
          }
        >
          <HugeiconsIcon
            icon={Target02Icon}
            size={12}
            strokeWidth={2}
            className="shrink-0 text-[var(--theme-accent)]"
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--theme-text)]">
            {agent.currentTask || 'Active mission'}
          </span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2}
            className="shrink-0 text-[var(--theme-muted)]"
          />
        </button>
      ) : null}

      {/* Capabilities & resources */}
      <div className="mx-2 grid grid-cols-2 gap-1.5 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2.5 py-2 text-[10px] text-[var(--theme-muted)]">
        <div className="flex items-center gap-1.5">
          <HugeiconsIcon icon={PuzzleIcon} size={11} strokeWidth={2} />
          <span className="truncate">
            {agent.capabilities.skills.length} skill
            {agent.capabilities.skills.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <HugeiconsIcon icon={Link01Icon} size={11} strokeWidth={2} />
          <span className="truncate">
            {agent.capabilities.mcpServers.length} MCP
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <HugeiconsIcon icon={Folder01Icon} size={11} strokeWidth={2} />
          <span className="truncate" title={agent.resources.workspace}>
            {formatShortPath(agent.resources.workspace)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-[var(--theme-text)]">
            {formatModelLabel(agent)}
          </span>
        </div>
      </div>

      {/* Needs setup banner */}
      {agent.needsSetup ? (
        <button
          type="button"
          onClick={() => onOpenSettings(agent.id)}
          className="mx-2 mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/10 px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-200 transition-colors hover:bg-amber-300/20"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />
          {agent.health.issues.length > 0
            ? agent.health.issues.join(' · ')
            : 'Needs setup'}
        </button>
      ) : null}

      {/* Blocked / needs human banner */}
      {isBlocked ? (
        <div className="mx-2 mt-2 rounded-lg border border-red-300/40 bg-red-300/10 px-2.5 py-2">
          <div className="flex items-start gap-2">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              size={14}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-red-400"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-red-300">
                {agent.needsHuman ? 'Needs human' : 'Blocked'}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] text-red-200/80">
                {agent.blockedReason ||
                  'Worker is blocked. Check runtime state.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleRecover()}
            disabled={recovering}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-red-300/30 bg-red-300/10 px-2 py-1.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-300/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={12}
              strokeWidth={2}
              className={recovering ? 'animate-spin' : ''}
            />
            {recovering ? 'Restarting…' : 'Restart session'}
          </button>
        </div>
      ) : null}

      {/* Cron mini panel */}
      <AnimatePresence initial={false}>
        {showCronPanel ? (
          <motion.section
            key="cron-panel"
            initial={{ height: 0, opacity: 0, y: -8 }}
            animate={{ height: 'auto', opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="mx-2 mb-3 mt-2 rounded-[1.25rem] border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-3">
              {agent.jobs.length > 0 ? (
                <>
                  <div className="max-h-[180px] space-y-2 overflow-y-auto pr-1">
                    {agent.jobs.map((job) => (
                      <div
                        key={job.id}
                        className="flex items-center gap-2 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2.5 py-2"
                      >
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={job.enabled}
                            onChange={() =>
                              toggleMutation.mutate({
                                jobId: job.id,
                                enabled: !job.enabled,
                              })
                            }
                            className="peer sr-only"
                            aria-label={
                              job.enabled ? 'Disable job' : 'Enable job'
                            }
                          />
                          <span className="h-5 w-9 rounded-full bg-primary-200 transition-colors peer-checked:bg-[var(--theme-accent)]" />
                          <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--theme-card)] shadow-sm transition-transform peer-checked:translate-x-4" />
                        </label>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-[var(--theme-text)]">
                            {displayJobName(job.name, agent.id)}
                          </p>
                          <p className="truncate text-[11px] text-[var(--theme-muted)]">
                            {describeJob(job)}
                          </p>
                        </div>
                        <Button
                          size="icon-sm"
                          variant="secondary"
                          className="h-7 w-7 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-card)] text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
                          onClick={() => runCronMutation.mutate(job.id)}
                          aria-label={`Run ${displayJobName(job.name, agent.id)} now`}
                        >
                          <HugeiconsIcon
                            icon={PlayIcon}
                            size={14}
                            strokeWidth={1.9}
                          />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      render={<a href="/jobs" />}
                      variant="secondary"
                      className="h-8 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
                    >
                      + Add Job
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-[var(--theme-muted)]">
                    No scheduled jobs
                  </p>
                  <Button
                    render={<a href="/jobs" />}
                    variant="secondary"
                    className="h-8 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
                  >
                    + Add Job
                  </Button>
                </div>
              )}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>

      {/* Activity summary */}
      <div className="mx-2 mt-auto rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2">
        <p className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--theme-muted)]">
          <span className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
          {status.label}
          <span className="text-[var(--theme-muted)]/70">·</span>
          <span className="truncate">{agent.activityLabel}</span>
        </p>
        {latestOutput ? (
          <p className="mt-1 line-clamp-2 text-[11px] text-[var(--theme-text)]">
            {latestOutput.summary}
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-[var(--theme-muted)]">
            No recent output
          </p>
        )}
      </div>

      {/* Quick actions */}
      <div className="mt-2 flex gap-2 px-2 pb-1">
        <Button
          size="sm"
          className="h-8 flex-1 rounded-xl bg-[var(--theme-accent)] text-xs font-medium text-primary-950 hover:bg-[var(--theme-accent-strong)] disabled:opacity-60"
          onClick={() => void handleRunTask()}
          disabled={isSending}
        >
          <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.9} />
          Run task
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className={cn(
            'h-8 flex-1 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]',
            showChat &&
              'border-[var(--theme-accent)] bg-[var(--theme-accent-soft)]',
          )}
          onClick={() => setShowChat((value) => !value)}
        >
          <HugeiconsIcon icon={Chatting01Icon} size={14} strokeWidth={1.9} />
          {showChat ? 'Hide chat' : 'Chat'}
        </Button>
      </div>

      {/* Inline chat */}
      <AnimatePresence initial={false}>
        {showChat ? (
          <motion.div
            key="inline-chat"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-2 overflow-hidden px-2"
          >
            <OperationsInlineChat
              agentName={agent.name}
              messages={messages}
              sendMessage={sendMessage}
              isSending={isSending}
              error={error}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </article>
  )
}
