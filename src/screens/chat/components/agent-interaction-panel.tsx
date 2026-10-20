'use client'

import { useMemo, useState } from 'react'
import type {
  AgentActivityInteraction,
  InteractionResponseState,
} from '@agorax/agent-activity-core'
import { canonicalInteractionKey } from '@agorax/agent-activity-core'
import {
  projectAgentInteraction,
  settleAgentInteraction,
  type AgentInteractionCard,
  type AgentInteractionQuestion,
} from '../lib/agent-interactions'
import {
  buildAskUserAnswerPayload,
  readOwnAnswer,
  writeOwnAnswer,
} from '@/lib/managed-agent-runtime/interactive-answer-payload'
import { ApprovalPromptCard } from './approval-prompt-card'

export type AgentInteractionResponseInput = {
  turnId: string
  requestId: string
  action?: string
  optionId?: string
  payload?: Record<string, unknown>
}

type InteractionResponseTracking = Pick<
  InteractionResponseState,
  'status' | 'errorMessage'
>

export function AgentInteractionPanel({
  interactions,
  responses = {},
  onRespond,
}: {
  interactions: Array<AgentActivityInteraction>
  /** Engine response-tracking state per interaction
   *  (keyed by canonicalInteractionKey). Drives submitting/failed settlement. */
  responses?: Record<string, InteractionResponseTracking | undefined>
  onRespond: (input: AgentInteractionResponseInput) => Promise<void>
}) {
  const cards = interactions
    .map((interaction) => {
      const card = projectAgentInteraction(interaction)
      if (!card) return null
      return {
        card,
        settlement: settleAgentInteraction(
          interaction,
          responses[
            canonicalInteractionKey(
              interaction.agentSessionId,
              interaction.turnId,
              interaction.requestId,
            )
          ] ?? null,
        ),
        output: interaction.output ?? null,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  if (cards.length === 0) return null

  return (
    <div className="mx-4 my-2 space-y-2">
      {cards.map(({ card, settlement, output }) => (
        <AgentInteractionCardView
          key={canonicalInteractionKey(
            card.agentSessionId,
            card.turnId,
            card.requestId,
          )}
          card={card}
          settlement={settlement}
          output={output}
          onRespond={onRespond}
        />
      ))}
    </div>
  )
}

function AgentInteractionCardView({
  card,
  settlement,
  output,
  onRespond,
}: {
  card: AgentInteractionCard
  settlement: ReturnType<typeof settleAgentInteraction>
  output: Record<string, unknown> | null
  onRespond: (input: AgentInteractionResponseInput) => Promise<void>
}) {
  const [lastInput, setLastInput] =
    useState<AgentInteractionResponseInput | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const actionable =
    card.supportsResponse &&
    card.status === 'pending' &&
    settlement.state !== 'responding'

  async function respond(input: AgentInteractionResponseInput) {
    setLastInput(input)
    setLocalError(null)
    try {
      await onRespond(input)
    } catch (reason) {
      setLocalError(friendlyInteractionError(reason))
    }
  }

  const errorMessage =
    settlement.state === 'failed'
      ? friendlyInteractionError(new Error(settlement.errorMessage))
      : localError

  const errorFooter =
    errorMessage ? (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
        {lastInput && card.status === 'pending' ? (
          <button
            type="button"
            disabled={settlement.state === 'responding'}
            onClick={() => void respond(lastInput)}
            className="border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)] disabled:opacity-50"
          >
            {settlement.state === 'responding' ? 'Sending...' : 'Retry'}
          </button>
        ) : null}
      </div>
    ) : null

  if (card.kind === 'approval' && card.presentation) {
    return (
      <ApprovalPromptCard
        lead={card.presentation.lead}
        title={card.title}
        leadDetails={card.presentation.leadDetails}
        settlementNote={
          <SettlementNote settlement={settlement} output={output} />
        }
        fields={card.presentation.fields}
        actions={card.actions}
        disabled={!actionable}
        submitting={settlement.state === 'responding'}
        activeActionId={lastInput?.optionId ?? null}
        onAction={(actionId) =>
          void respond({
            turnId: card.turnId,
            requestId: card.requestId,
            optionId: actionId,
          })
        }
        footer={errorFooter}
      />
    )
  }

  return (
    <section className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-4 pb-4 pt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] text-[var(--theme-muted)]">{card.kind}</div>
        <SettlementNote settlement={settlement} output={output} />
      </div>
      <div className="mt-1 text-[15px] font-medium leading-snug text-[var(--theme-text)]">
        {card.title}
      </div>

      {card.kind === 'question' && card.status === 'pending' ? (
        <QuestionForm
          questions={card.questions}
          disabled={!actionable}
          onSubmit={(payload) =>
            void respond({
              turnId: card.turnId,
              requestId: card.requestId,
              action: 'submit',
              payload,
            })
          }
        />
      ) : null}

      {card.kind === 'plan' && card.plan ? (
        <div className="mt-2">
          {card.plan.filePath ? (
            <p className="text-xs text-[var(--theme-muted)]">
              {card.plan.filePath}
            </p>
          ) : null}
          {card.plan.content ? (
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2 text-xs text-[var(--theme-text)]">
              {card.plan.content}
            </pre>
          ) : null}
          {actionable ? (
            <button
              type="button"
              disabled={!actionable}
              onClick={() =>
                void respond({
                  turnId: card.turnId,
                  requestId: card.turnId,
                  action: 'implement',
                })
              }
              className="mt-2 border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2 py-1 text-[11px] font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)] disabled:opacity-50"
            >
              执行计划
            </button>
          ) : (
            <p className="mt-1 text-[11px] italic text-[var(--theme-muted)]">
              计划已处理或当前不可回写
            </p>
          )}
        </div>
      ) : null}

      {errorFooter ? <div className="mt-2">{errorFooter}</div> : null}
    </section>
  )
}

function SettlementNote({
  settlement,
  output,
}: {
  settlement: ReturnType<typeof settleAgentInteraction>
  output: Record<string, unknown> | null
}) {
  if (settlement.state === 'responding') {
    return (
      <span className="text-[13px] text-[var(--theme-muted)]">Sending…</span>
    )
  }
  if (settlement.state === 'failed') {
    return (
      <span className="text-[13px] text-red-600 dark:text-red-400">Failed</span>
    )
  }
  if (settlement.state === 'answered') {
    const answers = Array.isArray(output?.answers)
      ? output.answers.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
      : []
    return (
      <span className="text-[13px] text-emerald-600 dark:text-emerald-400">
        {answers.length > 0 ? `已回答 · ${answers.join('；')}` : '已回答'}
      </span>
    )
  }
  if (settlement.state === 'superseded') {
    return (
      <span className="text-[13px] text-[var(--theme-muted)]">已被取代</span>
    )
  }
  return null
}

function QuestionForm({
  questions,
  disabled,
  onSubmit,
}: {
  questions: Array<AgentInteractionQuestion>
  disabled: boolean
  onSubmit: (payload: Record<string, unknown>) => void
}) {
  const [selectedByQuestionId, setSelectedByQuestionId] = useState<
    Record<string, string[]>
  >({})
  const [freeTextByQuestionId, setFreeTextByQuestionId] = useState<
    Record<string, string>
  >({})

  const answersByQuestionId = useMemo(() => {
    const result: Record<string, string | string[]> = {}
    for (const question of questions) {
      const selected = readOwnAnswer(selectedByQuestionId, question.id, [])
      const customAnswer = readOwnAnswer(
        freeTextByQuestionId,
        question.id,
        '',
      ).trim()
      if (question.multiSelect) {
        const answers = customAnswer ? [...selected, customAnswer] : selected
        if (answers.length > 0) writeOwnAnswer(result, question.id, answers)
        continue
      }
      const answer = customAnswer || selected[0]
      if (answer) writeOwnAnswer(result, question.id, answer)
    }
    return result
  }, [freeTextByQuestionId, questions, selectedByQuestionId])

  const allAnswered =
    questions.length > 0 &&
    questions.every((question) =>
      Object.prototype.hasOwnProperty.call(answersByQuestionId, question.id),
    )

  function toggleOption(question: AgentInteractionQuestion, label: string) {
    if (disabled) return
    setSelectedByQuestionId((current) => {
      const existing = readOwnAnswer(current, question.id, [])
      const next = question.multiSelect
        ? existing.includes(label)
          ? existing.filter((value) => value !== label)
          : [...existing, label]
        : existing.includes(label)
          ? []
          : [label]
      const updated = { ...current }
      writeOwnAnswer(updated, question.id, next)
      return updated
    })
  }

  function setFreeText(question: AgentInteractionQuestion, value: string) {
    if (disabled) return
    setFreeTextByQuestionId((current) => {
      const updated = { ...current }
      writeOwnAnswer(updated, question.id, value)
      return updated
    })
  }

  return (
    <div className="mt-3 space-y-3">
      {questions.map((question, index) => {
        const selected = readOwnAnswer(selectedByQuestionId, question.id, [])
        const freeText = readOwnAnswer(freeTextByQuestionId, question.id, '')
        return (
          <fieldset
            key={question.id}
            className="border border-[var(--theme-border)] bg-[var(--theme-bg)] p-2"
          >
            <legend className="px-1 text-[11px] font-medium text-[var(--theme-muted)]">
              {question.header}
              {questions.length > 1
                ? ` (${index + 1}/${questions.length})`
                : ''}
            </legend>
            <p className="text-xs text-[var(--theme-text)]">
              {question.question}
            </p>
            {question.options.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const active = selected.includes(option.label)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      data-active={active}
                      title={option.description || undefined}
                      onClick={() => toggleOption(question, option.label)}
                      className="border border-[var(--theme-border)] bg-[var(--theme-card)] px-2.5 py-1 text-xs text-[var(--theme-text)] hover:bg-[var(--theme-card2)] disabled:opacity-50 data-[active=true]:border-blue-500 data-[active=true]:bg-blue-500/10"
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {question.allowFreeText ? (
              <textarea
                value={freeText}
                disabled={disabled}
                placeholder="Or type a custom answer…"
                onChange={(event) =>
                  setFreeText(question, event.currentTarget.value)
                }
                className="mt-2 w-full border border-[var(--theme-border)] bg-[var(--theme-card)] p-1.5 text-xs text-[var(--theme-text)] disabled:opacity-50"
                rows={2}
              />
            ) : null}
          </fieldset>
        )
      })}
      <button
        type="button"
        disabled={disabled || !allAnswered}
        onClick={() =>
          onSubmit({ ...buildAskUserAnswerPayload(answersByQuestionId) })
        }
        className="border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)] disabled:opacity-50"
      >
        Submit answers
      </button>
    </div>
  )
}

/** Maps transport/engine failures to card-level friendly copy (never full-screen). */
function friendlyInteractionError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/was not accepted|not accepted/i.test(message)) {
    return '该请求正在处理中或已失效（冲突），结果以最新会话状态为准。'
  }
  if (/409|conflict/i.test(message)) {
    return '该请求已被其他人处理或已过期，请刷新确认最新状态。'
  }
  if (/429|too many|rate limit/i.test(message)) {
    return '请求过于频繁，请稍后重试。'
  }
  return message
}
