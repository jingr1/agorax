'use client'

import { useMemo, type ReactNode } from 'react'
import type {
  AgentInteractionAction,
  AgentInteractionActionSemantic,
  ApprovalPresentationField,
} from '../lib/agent-interactions'

export type ApprovalPromptCardProps = {
  lead: string
  title?: string | null
  leadDetails?: string | null
  settlementNote?: ReactNode
  fields: Array<ApprovalPresentationField>
  actions: Array<AgentInteractionAction>
  disabled?: boolean
  submitting?: boolean
  /** When set, only this option shows a left spinner while submitting. */
  activeActionId?: string | null
  onAction: (actionId: string) => void
  footer?: ReactNode
}

export function ApprovalPromptCard({
  lead,
  title,
  leadDetails,
  settlementNote,
  fields,
  actions,
  disabled = false,
  submitting = false,
  activeActionId = null,
  onAction,
  footer,
}: ApprovalPromptCardProps) {
  const ordered = useMemo(
    () => sortApprovalActions(actions),
    [actions],
  )
  const blocked = disabled || submitting

  return (
    <section
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200 flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-4 pb-4 pt-3 shadow-[0_8px_24px_color-mix(in_srgb,var(--theme-text)_8%,transparent)]"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium leading-snug text-[var(--theme-text)]">
            {lead}
          </h3>
          {title ? (
            <p className="mt-0.5 break-words text-[13px] leading-normal text-[var(--theme-muted)]">
              {title}
            </p>
          ) : null}
          {leadDetails ? (
            <p className="mt-0.5 break-words text-[13px] leading-normal text-[var(--theme-muted)]">
              {leadDetails}
            </p>
          ) : null}
        </div>
        {settlementNote ? (
          <div className="shrink-0 text-[13px] text-[var(--theme-muted)]">
            {settlementNote}
          </div>
        ) : null}
      </div>

      {fields.length > 0 ? (
        <div className="grid max-h-52 gap-2 overflow-y-auto">
          {fields.map((field) => (
            <ApprovalFieldBlock key={`${field.label}:${field.kind}`} field={field} />
          ))}
        </div>
      ) : null}

      <div className="grid shrink-0 gap-2">
        {ordered.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={blocked}
            onClick={() => onAction(action.id)}
            className={approvalOptionClassName(action.semantic)}
          >
            {submitting && activeActionId === action.id ? (
              <span
                aria-hidden
                className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--theme-border)] border-t-[var(--theme-accent)]"
              />
            ) : null}
            <span className="min-w-0 truncate">{action.label}</span>
          </button>
        ))}
      </div>

      {footer}
    </section>
  )
}

function ApprovalFieldBlock({ field }: { field: ApprovalPresentationField }) {
  const isCommand = field.kind === 'command'
  return (
    <div className="flex min-w-0 flex-col gap-[3px] overflow-hidden rounded-lg border border-[var(--theme-border)] bg-transparent px-3 py-3">
      <div className="line-clamp-2 text-[13px] font-medium text-[var(--theme-text)]">
        {field.label}
      </div>
      {isCommand ? (
        <pre
          title={field.value}
          className="max-h-[calc(1.3em*4)] overflow-hidden font-mono text-[11px] leading-[1.3] text-[var(--theme-muted)] [overflow-wrap:anywhere] line-clamp-4 whitespace-pre-wrap"
        >
          {field.value}
        </pre>
      ) : (
        <p className="break-words text-[11px] font-normal leading-snug text-[var(--theme-muted)]">
          {field.value}
        </p>
      )}
    </div>
  )
}

function sortApprovalActions(
  actions: Array<AgentInteractionAction>,
): Array<AgentInteractionAction> {
  const rank = (semantic: AgentInteractionActionSemantic | null) =>
    semantic === 'approve' || semantic === 'approve_always'
      ? 0
      : semantic === 'deny'
        ? 1
        : semantic === 'deny_and_stop'
          ? 2
          : 3
  return [...actions].sort(
    (left, right) => rank(left.semantic) - rank(right.semantic),
  )
}

function approvalOptionClassName(
  semantic: AgentInteractionActionSemantic | null,
): string {
  const tone =
    semantic === 'deny_and_stop'
      ? 'text-red-600 dark:text-red-400'
      : semantic === 'deny'
        ? 'text-[var(--theme-muted)]'
        : 'text-[var(--theme-text)]'
  return [
    'flex w-full min-w-0 shrink-0 items-center gap-3 rounded-lg border-0',
    'bg-[color-mix(in_srgb,var(--theme-bg)_70%,transparent)]',
    'px-3 py-2 text-left text-[13px] font-medium',
    'transition-colors duration-150',
    'hover:bg-[var(--theme-card2)]',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--theme-accent)] focus-visible:outline-offset-2',
    'disabled:cursor-not-allowed disabled:opacity-50',
    tone,
  ].join(' ')
}
