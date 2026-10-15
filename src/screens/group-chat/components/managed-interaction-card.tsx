/**
 * In-conversation renderer for group-chat managed interaction cards.
 *
 * The card payload is the canonical daemon interaction (decoded from the room
 * message); its status always comes from the canonical source — the daemon
 * interaction_update events during the turn and the canonical interaction
 * list re-read after writeback. This component keeps no pending state of its
 * own beyond transient submit/error display.
 */
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AgentActivityInteraction } from '@agorax/agent-activity-core'
import {
  projectManagedAgentInteraction,
  type ManagedAgentInteractionQuestion,
} from '@/screens/chat/lib/managed-agent-interactions'
import {
  buildAskUserAnswerPayload,
  readOwnAnswer,
  writeOwnAnswer,
} from '@/lib/managed-agent-runtime/interactive-answer-payload'
import {
  decodeManagedInteractionCard,
  type ManagedInteractionCardPayload,
} from '@/lib/group-chat-interaction-card'
import { respondToManagedInteraction } from '@/lib/group-chat-api'

export function ManagedInteractionRoomCard({
  roomId,
  messageId,
  content,
}: {
  roomId: string
  messageId: string
  content: string
}) {
  const payload = useMemo(() => decodeManagedInteractionCard(content), [content])
  if (!payload) {
    return <p className="whitespace-pre-wrap text-sm">{content}</p>
  }
  return (
    <ManagedInteractionCardBody
      roomId={roomId}
      messageId={messageId}
      payload={payload}
    />
  )
}

function ManagedInteractionCardBody({
  roomId,
  messageId,
  payload,
}: {
  roomId: string
  messageId: string
  payload: ManagedInteractionCardPayload
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const interaction: AgentActivityInteraction = useMemo(
    () => ({
      agentSessionId: payload.agentSessionId,
      turnId: payload.turnId,
      requestId: payload.requestId,
      kind: payload.kind,
      status: payload.status,
      toolName: payload.toolName,
      input: payload.input,
      metadata: payload.metadata,
      output: payload.output,
      createdAtUnixMs: 0,
      updatedAtUnixMs: 0,
    }),
    [payload],
  )
  const card = projectManagedAgentInteraction(interaction)

  const pending = payload.status === 'pending'
  const actionable = pending && card?.supportsResponse === true

  async function respond(input: {
    action?: string
    optionId?: string
    payload?: Record<string, unknown>
  }) {
    setSubmitting(true)
    setError(null)
    try {
      const result = await respondToManagedInteraction(roomId, messageId, input)
      if (!result.ok) {
        setError(result.error ?? 'Interaction response failed')
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : String(reason),
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (!card) {
    return (
      <p className="whitespace-pre-wrap text-sm italic opacity-80">
        [Interaction {payload.kind} · {payload.status}]
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant={payload.kind === 'approval' ? 'warning' : 'default'}>
          {payload.kind}
        </Badge>
        {!pending ? (
          <Badge variant="secondary">
            {payload.status === 'answered' ? 'answered' : 'superseded'}
          </Badge>
        ) : null}
      </div>
      <div className="text-sm font-medium">{card.title}</div>
      {card.detail ? (
        <p className="whitespace-pre-wrap break-all text-xs opacity-80">
          {card.detail}
        </p>
      ) : null}

      {card.kind === 'approval' ? (
        <div className="flex flex-wrap gap-2">
          {card.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.semantic === 'deny' || action.semantic === 'deny_and_stop' ? 'ghost' : 'secondary'}
              disabled={!actionable || submitting}
              onClick={() =>
                void respond({ optionId: action.id })
              }
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {card.kind === 'question' ? (
        <QuestionCardForm
          questions={card.questions}
          disabled={!actionable || submitting}
          onSubmit={(answerPayload) =>
            void respond({ action: 'submit', payload: answerPayload })
          }
        />
      ) : null}

      {card.kind === 'plan' && card.plan ? (
        <div>
          {card.plan.filePath ? (
            <p className="text-xs opacity-80">{card.plan.filePath}</p>
          ) : null}
          {card.plan.content ? (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-current/20 p-2 text-xs opacity-90">
              {card.plan.content}
            </pre>
          ) : null}
          <p className="mt-1 text-[11px] italic opacity-70">
            暂不支持回写（plan decision 端点未接入）
          </p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-red-500">{error}</p> : null}
    </div>
  )
}

function QuestionCardForm({
  questions,
  disabled,
  onSubmit,
}: {
  questions: Array<ManagedAgentInteractionQuestion>
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
      Object.prototype.hasOwnProperty.call(
        answersByQuestionId,
        question.id,
      ),
    )

  function toggleOption(
    question: ManagedAgentInteractionQuestion,
    label: string,
  ) {
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

  function setFreeText(
    question: ManagedAgentInteractionQuestion,
    value: string,
  ) {
    if (disabled) return
    setFreeTextByQuestionId((current) => {
      const updated = { ...current }
      writeOwnAnswer(updated, question.id, value)
      return updated
    })
  }

  return (
    <div className="space-y-2">
      {questions.map((question, index) => {
        const selected = readOwnAnswer(selectedByQuestionId, question.id, [])
        const freeText = readOwnAnswer(freeTextByQuestionId, question.id, '')
        return (
          <div key={question.id} className="rounded border border-current/20 p-2">
            <div className="text-[11px] font-medium opacity-70">
              {question.header}
              {questions.length > 1
                ? ` (${index + 1}/${questions.length})`
                : ''}
            </div>
            <p className="text-xs">{question.question}</p>
            {question.options.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const active = selected.includes(option.label)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      title={option.description || undefined}
                      onClick={() => toggleOption(question, option.label)}
                      className="rounded border border-current/30 px-2 py-0.5 text-xs disabled:opacity-50 aria-pressed:bg-blue-500/15 aria-pressed:border-blue-500"
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
                className="mt-1.5 w-full rounded border border-current/30 bg-transparent p-1.5 text-xs disabled:opacity-50"
                rows={2}
              />
            ) : null}
          </div>
        )
      })}
      <Button
        size="sm"
        disabled={disabled || !allAnswered}
        onClick={() =>
          onSubmit({ ...buildAskUserAnswerPayload(answersByQuestionId) })
        }
      >
        Submit answers
      </Button>
    </div>
  )
}
