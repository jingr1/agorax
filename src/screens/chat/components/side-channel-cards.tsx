'use client'

import { cn } from '@/lib/utils'

export function SideQuestionCard({
  question,
  answer,
  loading,
  error,
  onClose,
}: {
  question: string
  answer?: string
  loading?: boolean
  error?: string
  onClose: () => void
}) {
  return (
    <div
      className={cn(
        'pointer-events-auto mx-auto mb-2 w-full max-w-[var(--chat-content-max-width)] rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2.5 text-sm shadow-sm',
      )}
      role="status"
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            /btw
          </div>
          <div className="truncate text-xs text-sky-900/80 dark:text-sky-100/80">
            {question}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-sky-800 hover:bg-sky-500/20 dark:text-sky-100"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-sky-800/80 dark:text-sky-100/70">
          Asking side question…
        </p>
      ) : error ? (
        <p className="text-xs text-red-600 dark:text-red-300">{error}</p>
      ) : (
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-primary-900 dark:text-primary-100">
          {answer}
        </div>
      )}
    </div>
  )
}

export function BackgroundTasksBadge({
  tasks,
  onOpenSession,
}: {
  tasks: Array<{
    taskId: string
    status: 'running' | 'done' | 'error'
    prompt: string
    sessionId: string
    answer?: string
    error?: string
  }>
  onOpenSession?: (sessionId: string) => void
}) {
  if (tasks.length === 0) return null
  const running = tasks.filter((t) => t.status === 'running').length
  return (
    <div className="mb-2 space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-violet-800 dark:text-violet-200">
        <span className="inline-flex size-2 rounded-full bg-violet-500 animate-pulse" />
        {running > 0
          ? `${running} background task${running === 1 ? '' : 's'} running`
          : `${tasks.length} background task${tasks.length === 1 ? '' : 's'}`}
      </div>
      <ul className="space-y-1">
        {tasks.slice(0, 4).map((task) => (
          <li
            key={task.taskId}
            className="rounded-lg border border-violet-500/25 bg-violet-500/10 px-2.5 py-1.5 text-xs text-violet-950 dark:text-violet-50"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium">
                {task.prompt.slice(0, 80)}
              </span>
              <span className="shrink-0 uppercase tracking-wide opacity-70">
                {task.status}
              </span>
            </div>
            {task.status === 'done' && task.answer ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap opacity-90">
                {task.answer}
              </p>
            ) : null}
            {task.status === 'error' && task.error ? (
              <p className="mt-1 text-red-600 dark:text-red-300">
                {task.error}
              </p>
            ) : null}
            {onOpenSession && task.sessionId ? (
              <button
                type="button"
                className="mt-1 text-[11px] underline underline-offset-2 opacity-80 hover:opacity-100"
                onClick={() => onOpenSession(task.sessionId)}
              >
                Open background session
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
