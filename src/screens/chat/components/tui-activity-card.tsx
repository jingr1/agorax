import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * TUI-style activity card.
 *
 * Renders thinking + all tool calls as a single card. While streaming with
 * assistant text, MessageItem places this below the bubble so narration stays
 * chronological; before text arrives, chat-message-list owns the branched card.
 * Rows mimic Claude Code / Codex CLI tool output:
 *
 *   💭 Thinking 4s
 *     ⎿ Looking at chat component…
 *   ● Read message-item.tsx
 *     ⎿ 1240 lines
 *   ● Edit message-item.tsx
 *     ⎿ 2 changes
 *   ○ exec pnpm build
 *     ⎿ running…
 */

/** Keep the live tool list short so stick-to-bottom does not push narration
 * off the top of the chat viewport. */
export const STREAMING_TOOL_WINDOW = 8

export function visibleStreamingToolSections<T>(
  sections: Array<T>,
  isStreaming: boolean,
  windowSize = STREAMING_TOOL_WINDOW,
): { visible: Array<T>; hiddenCount: number } {
  if (!isStreaming || sections.length <= windowSize) {
    return { visible: sections, hiddenCount: 0 }
  }
  return {
    visible: sections.slice(-windowSize),
    hiddenCount: sections.length - windowSize,
  }
}

export type TuiToolSection = {
  key: string
  type: string
  input?: Record<string, unknown>
  preview?: string
  outputText: string
  errorText?: string
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
}

type TuiActivityCardProps = {
  toolSections: Array<TuiToolSection>
  thinking?: string | null
  thinkingElapsedSeconds?: number
  isStreaming: boolean
  /**
   * agorax host: keep the card mounted while the turn is busy even when
   * thinking/tools have not arrived yet (no empty-gap handoff).
   */
  keepMountedWhileBusy?: boolean
  /** Header label override — Thinking / Working / Activity. */
  statusTitle?: string | null
  expandAll?: boolean
  /** Format a tool's display label from name+args */
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  /** Get the most useful single arg to show next to the label */
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
}

function statusDot(
  state: TuiToolSection['state'],
  isStreamingActive: boolean,
): string {
  if (state === 'output-error') return '✗'
  if (state === 'output-available') return '●'
  // input-available / input-streaming = pending
  return isStreamingActive ? '○' : '●'
}

function statusColor(
  state: TuiToolSection['state'],
  isStreamingActive: boolean,
): string {
  if (state === 'output-error') return 'var(--theme-danger, #ef4444)'
  if (state === 'output-available') return 'var(--theme-success, #22c55e)'
  return isStreamingActive
    ? 'var(--theme-accent, #6366f1)'
    : 'var(--theme-muted, #888)'
}

function summarizeOutput(text: string, maxLen = 120): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  // First non-empty line, capped
  const firstLine = trimmed.split('\n').find((line) => line.trim()) ?? ''
  const compact = firstLine.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLen) return compact
  return `${compact.slice(0, maxLen - 1)}…`
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function ToolRow({
  section,
  isStreamingActive,
  expandAll,
  formatLabel,
  formatArg,
}: {
  section: TuiToolSection
  isStreamingActive: boolean
  expandAll?: boolean
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
}) {
  const [open, setOpen] = useState(() => !!expandAll)
  useEffect(() => {
    setOpen(!!expandAll)
  }, [expandAll])

  const isError = section.state === 'output-error'
  const isDone = section.state === 'output-available'
  const isPending = !isError && !isDone

  // Per-row elapsed timer when running
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!isPending || !isStreamingActive) {
      setElapsed(0)
      return
    }
    setElapsed(0)
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [isPending, isStreamingActive, section.key])

  const label = formatLabel(section.type, section.input)
  const arg = formatArg(section.type, section.input)
  const argLabel = section.preview ?? arg ?? null
  const argTruncated =
    argLabel && argLabel.length > 60 ? `${argLabel.slice(0, 57)}…` : argLabel

  const outputText = section.outputText || section.errorText || ''
  const hasInputData = section.input && Object.keys(section.input).length > 0
  const inputSummary =
    argTruncated ||
    (hasInputData
      ? summarizeOutput(JSON.stringify(section.input, null, 0))
      : '')
  const outputSummary = isPending
    ? isStreamingActive
      ? 'running…'
      : 'pending'
    : summarizeOutput(outputText) ||
      (isDone ? inputSummary || 'done' : 'failed')

  const dot = statusDot(section.state, isStreamingActive)
  const color = statusColor(section.state, isStreamingActive)
  const hasOutputData = !!(section.outputText || section.errorText)

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-baseline gap-2 px-3 py-1.5 text-left rounded-sm hover:bg-[color-mix(in_srgb,var(--theme-accent)_8%,transparent)]"
      >
        <span
          className={cn(
            'shrink-0 leading-none',
            isPending && isStreamingActive && 'animate-pulse',
          )}
          style={{ color }}
        >
          {dot}
        </span>
        <span
          className="shrink-0 font-semibold"
          style={{ color: 'var(--theme-text)' }}
        >
          {label}
        </span>
        {argTruncated && argTruncated !== label ? (
          <span
            className="truncate min-w-0 opacity-70"
            style={{ color: 'var(--theme-muted)' }}
          >
            {argTruncated}
          </span>
        ) : null}
        <span className="flex-1" />
        {isPending && isStreamingActive && elapsed > 0 ? (
          <span
            className="shrink-0 tabular-nums text-[10px] opacity-60"
            style={{ color: 'var(--theme-muted)' }}
          >
            {formatElapsed(elapsed)}
          </span>
        ) : null}
        <span
          className="shrink-0 text-[10px] opacity-40"
          style={{ color: 'var(--theme-muted)' }}
        >
          {open ? '▾' : '▸'}
        </span>
      </button>
      {/* Output preview line — TUI-style ⎿ */}
      <div
        className="flex items-baseline gap-1.5 px-3 pl-7 pb-0.5 opacity-70"
        style={{
          color: isError
            ? 'var(--theme-danger, #ef4444)'
            : 'var(--theme-muted)',
        }}
      >
        <span className="shrink-0 leading-none opacity-50">⎿</span>
        <span className="truncate min-w-0">{outputSummary}</span>
      </div>
      {open ? (
        <div
          className="mx-3 mt-2 mb-1 rounded border px-3 py-2 text-[11px]"
          style={{
            background:
              'var(--code-bg, color-mix(in srgb, var(--theme-card) 70%, transparent))',
            borderColor: 'var(--theme-border)',
          }}
        >
          {hasInputData ? (
            <div>
              <div
                className="mb-0.5 font-sans text-[9px] uppercase tracking-widest opacity-50"
                style={{ color: 'var(--theme-muted)' }}
              >
                Input
              </div>
              <pre
                className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded font-mono text-[10px]"
                style={{ color: 'var(--code-foreground, var(--theme-text))' }}
              >
                {JSON.stringify(section.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {hasOutputData ? (
            <div className={cn(hasInputData && 'mt-1.5')}>
              <div
                className="mb-0.5 font-sans text-[9px] uppercase tracking-widest opacity-50"
                style={{
                  color: isError
                    ? 'var(--theme-danger, #ef4444)'
                    : 'var(--theme-muted)',
                }}
              >
                {isError ? 'Error' : 'Output'}
              </div>
              <pre
                className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded font-mono text-[10px]"
                style={{
                  color: isError
                    ? 'var(--theme-danger, #ef4444)'
                    : 'var(--code-foreground, var(--theme-text))',
                }}
              >
                {section.outputText || section.errorText || ''}
              </pre>
            </div>
          ) : null}
          {!hasInputData && !hasOutputData ? (
            <div
              className="italic opacity-60"
              style={{ color: 'var(--theme-muted)' }}
            >
              No details
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingRow({
  thinking,
  elapsedSeconds,
  isStreaming,
  expandAll,
}: {
  thinking: string
  elapsedSeconds: number
  isStreaming: boolean
  expandAll?: boolean
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (expandAll) setOpen(true)
  }, [expandAll])

  const summary = summarizeOutput(thinking) || 'thinking…'

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-baseline gap-2 px-3 py-1.5 text-left rounded-sm hover:bg-[color-mix(in_srgb,var(--theme-accent)_8%,transparent)]"
      >
        <span className="shrink-0 leading-none">💭</span>
        <span
          className="shrink-0 font-semibold"
          style={{ color: 'var(--theme-text)' }}
        >
          Thinking
        </span>
        <span className="flex-1" />
        {isStreaming && elapsedSeconds > 0 ? (
          <span
            className="shrink-0 tabular-nums text-[10px] opacity-60"
            style={{ color: 'var(--theme-muted)' }}
          >
            {formatElapsed(elapsedSeconds)}
          </span>
        ) : null}
        <span
          className="shrink-0 text-[10px] opacity-40"
          style={{ color: 'var(--theme-muted)' }}
        >
          {open ? '▾' : '▸'}
        </span>
      </button>
      <div
        className="flex items-baseline gap-1.5 px-3 pl-7 pb-0.5 opacity-70"
        style={{ color: 'var(--theme-muted)' }}
      >
        <span className="shrink-0 leading-none opacity-50">⎿</span>
        <span className="truncate min-w-0 italic">{summary}</span>
      </div>
      {open ? (
        <div
          className="mx-3 mt-2 mb-1 rounded border px-3 py-2 text-[11px]"
          style={{
            background:
              'var(--code-bg, color-mix(in srgb, var(--theme-card) 70%, transparent))',
            borderColor: 'var(--theme-border)',
          }}
        >
          <p
            className="whitespace-pre-wrap text-pretty text-[12px]"
            style={{ color: 'var(--theme-text)' }}
          >
            {thinking}
          </p>
        </div>
      ) : null}
    </div>
  )
}

function TuiActivityCardComponent({
  toolSections,
  thinking,
  thinkingElapsedSeconds = 0,
  isStreaming,
  keepMountedWhileBusy = false,
  statusTitle = null,
  expandAll,
  formatLabel,
  formatArg,
}: TuiActivityCardProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Start open only while the turn is live (or forced). Settled thinking that
  // first mounts after done used to open fully (~100px+) above the bubble and
  // shove the transcript — keep that first paint collapsed to the header.
  const [cardOpen, setCardOpen] = useState(
    () => Boolean(expandAll) || isStreaming || keepMountedWhileBusy,
  )
  const hasThinking = !!(thinking && thinking.trim().length > 0)
  const hasTools = toolSections.length > 0
  const { visible: visibleTools, hiddenCount } = useMemo(
    () => visibleStreamingToolSections(toolSections, isStreaming),
    [toolSections, isStreaming],
  )

  useEffect(() => {
    if (expandAll) setCardOpen(true)
  }, [expandAll])

  const summary = useMemo(() => {
    if (!hasTools) return null
    const total = toolSections.length
    const errors = toolSections.filter((s) => s.state === 'output-error').length
    const running = toolSections.filter(
      (s) => s.state === 'input-available' || s.state === 'input-streaming',
    ).length
    const done = total - errors - running

    if (errors > 0) return `${errors} failed · ${done} done`
    if (running > 0) return `${running} running · ${done} done`
    return `${total} ${total === 1 ? 'tool' : 'tools'} · done`
  }, [toolSections, hasTools])

  const summaryColor = summary?.includes('failed')
    ? 'var(--theme-danger, #ef4444)'
    : summary?.includes('running')
      ? 'var(--theme-accent, #6366f1)'
      : 'var(--theme-success, #22c55e)'

  // Keep the tool list pinned to the latest row while streaming so new calls
  // stay visible inside the capped scroll region.
  useEffect(() => {
    if (!isStreaming) return
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [isStreaming, visibleTools.length, toolSections.length, hasThinking])

  // agorax: busy turns keep the host even with no content yet.
  // Settled empty rows still hide (nothing to archive).
  if (!hasThinking && !hasTools && !(keepMountedWhileBusy && isStreaming)) {
    return null
  }

  const title =
    (typeof statusTitle === 'string' && statusTitle.trim()) ||
    (isStreaming
      ? hasTools
        ? '⚡ Working'
        : 'Thinking…'
      : 'Activity')

  return (
    <div
      className="w-full max-w-[min(100%,720px)] overflow-hidden rounded-lg border"
      style={{
        background:
          'color-mix(in srgb, var(--theme-card2) 92%, var(--theme-bg) 8%)',
        borderColor: 'color-mix(in srgb, var(--theme-border) 88%, transparent)',
      }}
    >
      <button
        type="button"
        onClick={() => setCardOpen((v) => !v)}
        className="sticky top-0 z-[1] flex w-full items-center gap-2 border-b px-4 py-2.5 text-left"
        style={{
          borderColor:
            'color-mix(in srgb, var(--theme-border) 70%, transparent)',
          background: 'color-mix(in srgb, var(--theme-card) 92%, transparent)',
        }}
      >
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: 'var(--theme-muted)' }}
        >
          {title}
        </span>
        <span className="flex-1" />
        {summary ? (
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: summaryColor }}
          >
            {summary}
          </span>
        ) : null}
        {isStreaming ? (
          <span
            className="size-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--theme-accent, #6366f1)' }}
          />
        ) : null}
        <span
          className="ml-1 font-mono text-[10px] opacity-45"
          style={{ color: 'var(--theme-muted)' }}
        >
          {cardOpen ? '▾' : '▸'}
        </span>
      </button>
      <div
        ref={bodyRef}
        className={cn(
          // Keep the same max-height for streaming and settled — flipping
          // 280px ↔ 1000px on settle reflows the bubble below (transcript jump).
          'flex flex-col gap-1.5 px-2 transition-[max-height,padding] duration-300 ease-in-out overflow-hidden',
          cardOpen
            ? 'max-h-[min(40vh,280px)] overflow-y-auto py-3'
            : 'max-h-0 py-0',
        )}
      >
          {hasThinking ? (
            <ThinkingRow
              thinking={thinking!}
              elapsedSeconds={thinkingElapsedSeconds}
              isStreaming={isStreaming}
              expandAll={expandAll}
            />
          ) : null}
          {hiddenCount > 0 ? (
            <div
              className="px-3 py-1 font-mono text-[11px] opacity-60"
              style={{ color: 'var(--theme-muted)' }}
            >
              +{hiddenCount} earlier {hiddenCount === 1 ? 'tool' : 'tools'}
            </div>
          ) : null}
          {visibleTools.map((section, index) => (
            <ToolRow
              key={section.key || `${section.type}-${index}`}
              section={section}
              isStreamingActive={isStreaming}
              expandAll={expandAll}
              formatLabel={formatLabel}
              formatArg={formatArg}
            />
          ))}
        </div>
    </div>
  )
}

export const TuiActivityCard = memo(TuiActivityCardComponent)
