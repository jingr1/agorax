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
 * - approval: `input.toolCall.title` carries the display title;
 *   nested `toolCall.input` merged with root input supplies preview fields
 *   (command/path/summary/url/query); actions from `metadata.actions` with
 *   `input.options` fallback.
 * - question: `input.questions` AskUserQuestion shape.
 * - plan: info card with optional implement writeback.
 */

export type AgentInteractionActionSemantic =
  | 'approve'
  | 'approve_always'
  | 'deny'
  | 'deny_and_stop'

export type AgentInteractionAction = {
  id: string
  label: string
  semantic: AgentInteractionActionSemantic | null
}

export type AgentInteractionQuestionOption = {
  id: string
  label: string
  description: string
}

export type AgentInteractionQuestion = {
  id: string
  header: string
  question: string
  options: Array<AgentInteractionQuestionOption>
  multiSelect: boolean
  allowFreeText: boolean
}

export type ApprovalToolDetails = {
  command: string | null
  path: string | null
  summary: string | null
  url: string | null
  query: string | null
}

export type ApprovalPresentationFieldKind = 'command' | 'text'

export type ApprovalPresentationField = {
  label: string
  value: string
  kind: ApprovalPresentationFieldKind
}

export type ApprovalPresentation = {
  lead: string
  leadDetails: string | null
  fields: Array<ApprovalPresentationField>
}

export type AgentInteractionCard = {
  agentSessionId: string
  turnId: string
  requestId: string
  kind: AgentActivityInteraction['kind']
  /** Canonical interaction status — answered/superseded cards render
   *  read-only; only a pending card is actionable. */
  status: AgentActivityInteraction['status']
  title: string
  /** approval only; structured fields for ApprovalPromptCard */
  presentation: ApprovalPresentation | null
  /** approval only; empty for other kinds */
  actions: Array<AgentInteractionAction>
  /** question only; empty for other kinds */
  questions: Array<AgentInteractionQuestion>
  /** plan only; null for other kinds */
  plan: { content: string; filePath: string | null } | null
  /** false when the card cannot write back (answered/superseded still render). */
  supportsResponse: boolean
}

export function projectAgentInteraction(
  interaction: AgentActivityInteraction,
): AgentInteractionCard | null {
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
  AgentInteractionCard,
  'agentSessionId' | 'turnId' | 'requestId' | 'kind' | 'status'
>

function projectApproval(
  interaction: AgentActivityInteraction,
  base: CardBase,
): AgentInteractionCard | null {
  const input = record(interaction.input)
  const toolCall = record(input?.toolCall)
  const title =
    text(toolCall?.title) ||
    text(toolCall?.name) ||
    text(interaction.toolName) ||
    'Approval'
  const displayInput = mergeApprovalDisplayInput(input, toolCall)
  const details = getApprovalToolDetails(displayInput)
  const presentation = formatApprovalPresentation(details)

  const actions = approvalActions(interaction)
  if (actions.length === 0) return null

  return {
    ...base,
    title,
    presentation,
    actions,
    questions: [],
    plan: null,
    supportsResponse: true,
  }
}

/** Merge root input + nested toolCall.input (nested wins on key clash). */
function mergeApprovalDisplayInput(
  input: Record<string, unknown> | null,
  toolCall: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const root = input ? { ...input } : null
  const nested = record(toolCall?.input)
  if (!root && !nested) return null
  if (!root) return { ...nested! }
  if (!nested) return root
  return { ...root, ...nested }
}

/**
 * Extract labeled approval preview fields from merged display input.
 * Prefers first non-empty among each key group.
 */
export function getApprovalToolDetails(
  displayInput: Record<string, unknown> | null,
): ApprovalToolDetails {
  if (!displayInput) {
    return {
      command: null,
      path: null,
      summary: null,
      url: null,
      query: null,
    }
  }
  return {
    command: firstText(displayInput, ['command', 'cmd']),
    path: firstText(displayInput, ['path', 'file_path', 'filePath']),
    summary: firstText(displayInput, ['reason', 'description']),
    url: firstText(displayInput, ['url', 'uri']),
    query: firstText(displayInput, ['query', 'pattern']),
  }
}

export function formatApprovalPresentation(
  details: ApprovalToolDetails,
  options?: { lead?: string; leadDetails?: string | null },
): ApprovalPresentation {
  const fields: Array<ApprovalPresentationField> = []
  if (details.command) {
    fields.push({ label: 'Command', value: details.command, kind: 'command' })
  }
  if (details.path) {
    fields.push({ label: 'Path', value: details.path, kind: 'text' })
  }
  if (details.summary) {
    fields.push({ label: 'Summary', value: details.summary, kind: 'text' })
  }
  if (details.url) {
    fields.push({ label: 'URL', value: details.url, kind: 'text' })
  }
  if (details.query) {
    fields.push({ label: 'Query', value: details.query, kind: 'text' })
  }
  return {
    lead: options?.lead?.trim() || '需要批准',
    leadDetails: options?.leadDetails?.trim() || null,
    fields,
  }
}

function firstText(
  recordValue: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = text(recordValue[key])
    if (value) return value
  }
  return null
}

function approvalActions(
  interaction: AgentActivityInteraction,
): Array<AgentInteractionAction> {
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
    .filter((action): action is AgentInteractionAction => action !== null)
  if (fromMetadata.length > 0) return fromMetadata

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
    .filter((action): action is AgentInteractionAction => action !== null)
}

/**
 * Maps canonical action semantics and provider option kinds onto the closed
 * semantic set. Daemon parity (normalizePermissionOptionToken +
 * interactionActionSemantic): tokenize lowercase-alphanumerics first, so
 * "allowOnce", "approve", "rejectAlways" all classify deterministically.
 */
function actionSemantic(
  value: unknown,
): AgentInteractionActionSemantic | null {
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
): AgentInteractionCard | null {
  const questions = normalizeAgentQuestions(
    record(interaction.input)?.questions,
  )
  if (questions.length === 0) return null
  return {
    ...base,
    title: text(interaction.toolName) || 'Question',
    presentation: null,
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
 */
export function normalizeAgentQuestions(
  rawQuestions: unknown,
): Array<AgentInteractionQuestion> {
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
): AgentInteractionCard | null {
  const input = record(interaction.input)
  const toolCall = record(input?.toolCall)
  const title = text(toolCall?.title) || text(interaction.toolName) || 'Plan'
  const content = text(input?.plan) ?? ''
  const filePath = text(input?.filePath) ?? null
  if (!content && !filePath) return null
  return {
    ...base,
    title,
    presentation: null,
    actions: [],
    questions: [],
    plan: { content, filePath },
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
    const status = text(message.status) || text(payload.status)
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

export type AgentInteractionSettlement =
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
export function settleAgentInteraction(
  interaction: AgentActivityInteraction,
  response: Pick<InteractionResponseState, 'status' | 'errorMessage'> | null,
): AgentInteractionSettlement {
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
