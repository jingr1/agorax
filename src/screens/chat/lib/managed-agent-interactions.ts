import type {
  AgentActivityInteraction,
  AgentActivityMessage,
  InteractionResponseState,
} from '@agorax/agent-activity-core'

/**
 * Typed projection of a canonical daemon interaction into a UI card model.
 *
 * Field sources follow the daemon's canonical interaction contract
 * (agorax-agent-daemon interactive_projection.go → daemon-adapter
 * agentActivityInteractionFromDaemonInteraction):
 *
 * - approval: `input.toolCall.title` carries the display title,
 *   `input.toolCall.input` (or the merged root input) carries the preview
 *   detail (command/description/reason/path/url/...), and the action list
 *   comes from `metadata.actions` (`{id, label, semantic}`) with
 *   `input.options` (`{optionId|id, name|label, kind}`) as the canonical
 *   fallback. `semantic` classifies approve / approve_always / deny /
 *   deny_and_stop.
 * - question: `input.questions` is the AskUserQuestion tool input shape
 *   (`{id?, header, question, multiSelect?, allowFreeText?, options:
 *   [{id?, label, description}]}`), matching normalizeAskUserQuestions
 *   contract.
 * - plan: info card with optional implement writeback when the daemon
 *   plan-decision endpoint is available (`supportsResponse = true`). Host
 *   only admits Codex `implement_prompt` strategy; other providers fail closed
 *   at the API rather than faking success.
 */

export type ManagedAgentInteractionActionSemantic =
  | 'approve'
  | 'approve_always'
  | 'deny'
  | 'deny_and_stop'

export type ManagedAgentInteractionAction = {
  id: string
  label: string
  semantic: ManagedAgentInteractionActionSemantic | null
}

export type ManagedAgentInteractionQuestionOption = {
  id: string
  label: string
  description: string
}

export type ManagedAgentInteractionQuestion = {
  id: string
  header: string
  question: string
  options: Array<ManagedAgentInteractionQuestionOption>
  multiSelect: boolean
  allowFreeText: boolean
}

export type ManagedAgentInteractionCard = {
  agentSessionId: string
  turnId: string
  requestId: string
  kind: AgentActivityInteraction['kind']
  /** Canonical interaction status — answered/superseded cards render
   *  read-only; only a pending card is actionable. */
  status: AgentActivityInteraction['status']
  title: string
  detail: string
  /** approval only; empty for other kinds */
  actions: Array<ManagedAgentInteractionAction>
  /** question only; empty for other kinds */
  questions: Array<ManagedAgentInteractionQuestion>
  /** plan only; null for other kinds */
  plan: { content: string; filePath: string | null } | null
  /** false when the card cannot write back (answered/superseded still render). */
  supportsResponse: boolean
}

export function projectManagedAgentInteraction(
  interaction: AgentActivityInteraction,
): ManagedAgentInteractionCard | null {
  const base = {
    agentSessionId: interaction.agentSessionId,
    turnId: interaction.turnId,
    requestId: interaction.requestId,
    kind: interaction.kind,
    status: interaction.status,
  }
  switch (interaction.kind) {
    case 'approval':
      return projectApproval(interaction, base)
    case 'question':
      return projectQuestion(interaction, base)
    case 'plan':
      return projectPlan(interaction, base)
    default:
      return null
  }
}

type CardBase = Pick<
  ManagedAgentInteractionCard,
  'agentSessionId' | 'turnId' | 'requestId' | 'kind' | 'status'
>

function projectApproval(
  interaction: AgentActivityInteraction,
  base: CardBase,
): ManagedAgentInteractionCard | null {
  const input = record(interaction.input)
  const toolCall = record(input?.toolCall)
  const title =
    text(toolCall?.title) ||
    text(toolCall?.name) ||
    text(interaction.toolName) ||
    'Approval'
  const displayInput = record(toolCall?.input) ?? input
  const detail = approvalDetail(displayInput)

  const actions = approvalActions(interaction)
  if (actions.length === 0) return null

  return {
    ...base,
    title,
    detail,
    actions,
    questions: [],
    plan: null,
    supportsResponse: true,
  }
}

/** Preview fields the daemon normalizes into the approval display input. */
const APPROVAL_DETAIL_KEYS = [
  'command',
  'description',
  'reason',
  'path',
  'file_path',
  'filePath',
  'url',
  'uri',
  'prompt',
  'instruction',
  'query',
  'pattern',
  'cwd',
] as const

function approvalDetail(displayInput: Record<string, unknown> | null): string {
  if (!displayInput) return ''
  for (const key of APPROVAL_DETAIL_KEYS) {
    const value = text(displayInput[key])
    if (value) return value
  }
  return ''
}

function approvalActions(
  interaction: AgentActivityInteraction,
): Array<ManagedAgentInteractionAction> {
  const fromMetadata = recordArray(record(interaction.metadata)?.actions)
    .map((action) => {
      const id = text(action.id)
      const label = text(action.label)
      if (!id || !label) return null
      return {
        id,
        label,
        semantic:
          actionSemantic(action.semantic) ?? actionSemantic(action.kind),
      }
    })
    .filter(
      (action): action is ManagedAgentInteractionAction => action !== null,
    )
  if (fromMetadata.length > 0) return fromMetadata

  // Canonical fallback: normalized approval options on the interaction input.
  return recordArray(record(interaction.input)?.options)
    .map((option) => {
      const id = text(option.optionId) || text(option.id) || text(option.name)
      const label = text(option.name) || text(option.label) || id
      if (!id || !label) return null
      return {
        id,
        label,
        semantic: actionSemantic(option.kind),
      }
    })
    .filter(
      (action): action is ManagedAgentInteractionAction => action !== null,
    )
}

/**
 * Maps canonical action semantics and provider option kinds onto the closed
 * semantic set. Daemon parity (normalizePermissionOptionToken +
 * interactionActionSemantic): tokenize lowercase-alphanumerics first, so
 * "allowOnce", "approve", "rejectAlways" all classify deterministically.
 */
function actionSemantic(
  value: unknown,
): ManagedAgentInteractionActionSemantic | null {
  const token = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  switch (token) {
    case 'approve':
    case 'allowonce':
      return 'approve'
    case 'approvealways':
    case 'allowalways':
      return 'approve_always'
    case 'deny':
    case 'rejectonce':
      return 'deny'
    case 'denyandstop':
    case 'rejectalways':
      return 'deny_and_stop'
    default:
      return null
  }
}

function projectQuestion(
  interaction: AgentActivityInteraction,
  base: CardBase,
): ManagedAgentInteractionCard | null {
  const questions = normalizeManagedAgentQuestions(
    record(interaction.input)?.questions,
  )
  if (questions.length === 0) return null
  return {
    ...base,
    title: text(interaction.toolName) || 'Question',
    detail: '',
    actions: [],
    questions,
    plan: null,
    supportsResponse: true,
  }
}

/**
 * Normalizes the raw AskUserQuestion tool input `questions` array into the
 * view-model shape. Provider payloads (codex / ACP) may omit UI-facing
 * question or option ids, so deterministic contract identities are minted at
 * this boundary — renderers and automation never fall back to array position.
 * Shared ask-user question normalizer.
 */
export function normalizeManagedAgentQuestions(
  rawQuestions: unknown,
): Array<ManagedAgentInteractionQuestion> {
  const seenQuestionIds = new Set<string>()
  return recordArray(rawQuestions).flatMap((question, index) => {
    const questionId =
      text(question.id) || askUserContractId('question', question)
    if (seenQuestionIds.has(questionId)) return []
    seenQuestionIds.add(questionId)
    const seenOptionIds = new Set<string>()
    return [
      {
        id: questionId,
        header: text(question.header) || `Question ${index + 1}`,
        question:
          text(question.question) ||
          text(question.header) ||
          `Question ${index + 1}`,
        options: recordArray(question.options).flatMap((option) => {
          const label = text(option.label)
          if (!label) return []
          const optionId =
            text(option.id) ||
            askUserContractId('option', {
              description: text(option.description) ?? '',
              label,
              questionId,
            })
          if (seenOptionIds.has(optionId)) return []
          seenOptionIds.add(optionId)
          return [
            {
              id: optionId,
              label,
              description: text(option.description) ?? '',
            },
          ]
        }),
        multiSelect: Boolean(question.multiSelect),
        allowFreeText:
          question.allowFreeText === false || question.allow_free_text === false
            ? false
            : true,
      },
    ]
  })
}

/** Deterministic id for provider payloads missing ids (FNV-1a). */
function askUserContractId(
  scope: 'question' | 'option',
  value: unknown,
): string {
  let hash = 0x811c9dc5
  for (const character of JSON.stringify(value)) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `contract-${scope}-${(hash >>> 0).toString(36)}`
}

function projectPlan(
  interaction: AgentActivityInteraction,
  base: CardBase,
): ManagedAgentInteractionCard | null {
  const input = record(interaction.input)
  const toolCall = record(input?.toolCall)
  const title = text(toolCall?.title) || text(interaction.toolName) || 'Plan'
  const content = text(input?.plan) ?? ''
  const filePath = text(input?.filePath) ?? null
  if (!content && !filePath) return null
  return {
    ...base,
    title,
    detail: '',
    actions: [],
    questions: [],
    plan: { content, filePath },
    // Host plan-decision is available; Codex implement_prompt succeeds, other
    // providers fail closed at the daemon with an honest error.
    supportsResponse: true,
  }
}

/**
 * When ACP deferApprovalUntilToolInput withholds interaction.requested (Kimi
 * bash often parks command JSON in tool output instead of rawInput), the turn
 * still has a waiting_approval tool_call message with options. Project those
 * into pending Interactions so the approve panel can unblock SubmitInteractive
 * against the live pendingApprovals map.
 */
export function projectPendingApprovalsFromToolCallMessages(
  messages: readonly AgentActivityMessage[],
  interactions: readonly AgentActivityInteraction[],
): AgentActivityInteraction[] {
  const pendingKeys = new Set(
    interactions
      .filter((item) => item.status === 'pending')
      .map((item) => `${item.turnId}\0${item.requestId}`),
  )
  const synthesized: AgentActivityInteraction[] = []
  for (const message of messages) {
    if (message.kind !== 'tool_call' && message.kind !== 'tool') continue
    const payload = record(message.payload)
    if (!payload) continue
    const status =
      text(message.status) || text(payload.status)
    if (status !== 'waiting_approval' && status !== 'awaiting_approval') {
      continue
    }
    const callType = text(payload.callType)
    if (callType && callType !== 'approval') continue
    const input = record(payload.input) ?? {}
    const requestId = text(input.requestId) || text(payload.requestId)
    if (!requestId || !message.turnId) continue
    const key = `${message.turnId}\0${requestId}`
    if (pendingKeys.has(key)) continue
    pendingKeys.add(key)

    const mergedInput = mergeApprovalPreviewFromOutput(input, payload.output)
    const toolCall = record(mergedInput.toolCall)
    synthesized.push({
      agentSessionId: message.agentSessionId,
      turnId: message.turnId,
      requestId,
      kind: 'approval',
      status: 'pending',
      toolName:
        text(toolCall?.title) ||
        text(payload.toolName) ||
        text(payload.name) ||
        'Approval',
      input: mergedInput,
      output: record(payload.output),
      createdAtUnixMs: message.occurredAtUnixMs,
      updatedAtUnixMs: message.occurredAtUnixMs,
    })
  }
  return synthesized.length === 0
    ? [...interactions]
    : [...interactions, ...synthesized]
}

function mergeApprovalPreviewFromOutput(
  input: Record<string, unknown>,
  output: unknown,
): Record<string, unknown> {
  const outputRecord = record(output)
  const rawText = text(outputRecord?.text) || text(outputRecord?.output)
  if (!rawText || rawText[0] !== '{') return { ...input }
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(rawText) as unknown
    parsed = record(value)
  } catch {
    return { ...input }
  }
  if (!parsed) return { ...input }
  const merged: Record<string, unknown> = { ...input }
  for (const [key, value] of Object.entries(parsed)) {
    if (merged[key] === undefined) merged[key] = value
  }
  const toolCall = record(merged.toolCall) ?? {}
  const toolInput = record(toolCall.input) ?? {}
  const nextToolInput = { ...toolInput }
  for (const [key, value] of Object.entries(parsed)) {
    if (nextToolInput[key] === undefined) nextToolInput[key] = value
  }
  merged.toolCall = { ...toolCall, input: nextToolInput }
  return merged
}

// ── Per-interaction settlement ────────────────────────────────────────────

export type ManagedAgentInteractionSettlement =
  | { state: 'pending' }
  | { state: 'responding' }
  | { state: 'failed'; errorMessage: string }
  | { state: 'answered' }
  | { state: 'superseded' }

/**
 * Joins the canonical interaction status with the engine's response-tracking
 * state into one settlement value per card. The canonical interaction status
 * wins for answered/superseded; while pending, an in-flight engine response
 * renders as `responding` and a failed one as `failed` (retry allowed — the
 * engine accepts an explicit resubmit of the exact same response).
 */
export function settleManagedAgentInteraction(
  interaction: AgentActivityInteraction,
  response: Pick<InteractionResponseState, 'status' | 'errorMessage'> | null,
): ManagedAgentInteractionSettlement {
  if (interaction.status === 'answered') return { state: 'answered' }
  if (interaction.status === 'superseded') return { state: 'superseded' }
  if (response?.status === 'failed') {
    return {
      state: 'failed',
      errorMessage:
        response.errorMessage?.trim() || 'Interaction response failed',
    }
  }
  if (response?.status === 'responding' || response?.status === 'unknown') {
    return { state: 'responding' }
  }
  return { state: 'pending' }
}

// ── Value readers ─────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = record(item)
    return parsed ? [parsed] : []
  })
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}
