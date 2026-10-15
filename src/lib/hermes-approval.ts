/**
 * Hermes gateway approval ↔ Agorax Interaction mapping.
 *
 * Mirrors hermes-webui `api/gateway_chat._gateway_runs_approval_event` +
 * `POST /v1/runs/{run_id}/approval` choice contract (once|session|always|deny).
 */

import type { AgentActivityInteraction } from '@agorax/agent-activity-core'

export const HERMES_APPROVAL_CHOICES = [
  'once',
  'session',
  'always',
  'deny',
] as const

export type HermesApprovalChoice = (typeof HERMES_APPROVAL_CHOICES)[number]

const CHOICE_LABELS: Record<HermesApprovalChoice, string> = {
  once: 'Allow once',
  session: 'Allow for session',
  always: 'Always allow',
  deny: 'Deny',
}

const CHOICE_SEMANTIC: Record<
  HermesApprovalChoice,
  'approve' | 'approve_always' | 'deny'
> = {
  once: 'approve',
  session: 'approve',
  always: 'approve_always',
  deny: 'deny',
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** True when an SSE frame (event name or payload) is a gateway approval request. */
export function isHermesApprovalRequestEvent(
  eventName: string,
  data: Record<string, unknown>,
): boolean {
  const fromPayload = readString(data.event) || readString(data.type)
  const name = (fromPayload || eventName).toLowerCase()
  return (
    name === 'approval.request' ||
    name === 'hermes.approval.request' ||
    name === 'approval'
  )
}

/** True when an SSE frame reports an approval was resolved. */
export function isHermesApprovalRespondedEvent(
  eventName: string,
  data: Record<string, unknown>,
): boolean {
  const fromPayload = readString(data.event) || readString(data.type)
  const name = (fromPayload || eventName).toLowerCase()
  return (
    name === 'approval.responded' || name === 'hermes.approval.responded'
  )
}

export function normalizeHermesApprovalChoices(
  raw: unknown,
  options?: { allowPermanent?: boolean; allowSession?: boolean },
): HermesApprovalChoice[] {
  const allowPermanent = options?.allowPermanent !== false
  const allowSession = options?.allowSession !== false
  const fromList = Array.isArray(raw)
    ? raw
        .map((item) => readString(item).toLowerCase())
        .filter((item): item is HermesApprovalChoice =>
          (HERMES_APPROVAL_CHOICES as readonly string[]).includes(item),
        )
    : []
  const base =
    fromList.length > 0
      ? fromList
      : (['once', 'session', 'always', 'deny'] as HermesApprovalChoice[])
  return base.filter((choice) => {
    if (choice === 'always' && !allowPermanent) return false
    if (choice === 'session' && !allowSession) return false
    return true
  })
}

export function resolveHermesApprovalChoice(input: {
  optionId?: string | null
  action?: string | null
  payload?: Record<string, unknown> | null
}): HermesApprovalChoice | null {
  const candidates = [
    readString(input.optionId),
    readString(input.action),
    readString(input.payload?.choice),
  ]
  for (const raw of candidates) {
    const token = raw.toLowerCase()
    if ((HERMES_APPROVAL_CHOICES as readonly string[]).includes(token)) {
      return token as HermesApprovalChoice
    }
    // Managed panel semantics → Hermes choice.
    if (token === 'approve' || token === 'allowonce' || token === 'allow_once') {
      return 'once'
    }
    if (token === 'approvealways' || token === 'allowalways' || token === 'allow_always') {
      return 'always'
    }
    if (token === 'deny' || token === 'reject' || token === 'rejectonce') {
      return 'deny'
    }
  }
  return null
}

export type NormalizedHermesApproval = {
  approvalId: string
  runId: string
  tool: string
  command: string
  description: string
  patternKey: string
  patternKeys: string[]
  riskLevel: string
  choices: HermesApprovalChoice[]
  allowPermanent: boolean
  rawApprovalIdPresent: boolean
}

/**
 * Map a gateway approval.request payload to a stable Workspace shape.
 * Returns null when there is nothing actionable to show.
 */
export function normalizeHermesApprovalPayload(
  data: Record<string, unknown>,
  fallbackRunId?: string | null,
): NormalizedHermesApproval | null {
  const tool =
    readString(data.tool) ||
    readString(data.function_name) ||
    readString(data.pattern_key) ||
    'terminal'
  const command = readString(data.command)
  const description = readString(data.description)
  if (!tool && !command && !description) return null

  const patternKey = readString(data.pattern_key)
  const patternKeys = Array.isArray(data.pattern_keys)
    ? data.pattern_keys.map((item) => readString(item)).filter(Boolean)
    : patternKey
      ? [patternKey]
      : []

  const rawChoices = Array.isArray(data.choices) ? data.choices : []
  let allowPermanent = data.allow_permanent
  if (allowPermanent === undefined || allowPermanent === null) {
    allowPermanent =
      rawChoices.length === 0 ||
      rawChoices.some((item) => readString(item).toLowerCase() === 'always')
  }
  const allowSession = data.allow_session !== false
  const choices = normalizeHermesApprovalChoices(rawChoices, {
    allowPermanent: Boolean(allowPermanent),
    allowSession,
  })
  if (choices.length === 0) return null

  const rawApprovalId =
    readString(data.approval_id) || readString(data.id) || ''
  const approvalId =
    rawApprovalId ||
    `hermes-approval:${readString(data.run_id) || fallbackRunId || 'unknown'}:${patternKey || command || tool}`

  return {
    approvalId,
    runId:
      readString(data.run_id) ||
      readString(data.runId) ||
      readString(fallbackRunId) ||
      '',
    tool,
    command,
    description,
    patternKey,
    patternKeys,
    riskLevel: readString(data.risk_level) || 'high',
    choices,
    allowPermanent: Boolean(allowPermanent),
    rawApprovalIdPresent: Boolean(rawApprovalId),
  }
}

/** Build a pending Interaction that ManagedAgentInteractionPanel can project. */
export function hermesApprovalToInteraction(input: {
  workspaceId: string
  agentSessionId: string
  turnId: string
  approval: NormalizedHermesApproval
  status?: AgentActivityInteraction['status']
  choice?: HermesApprovalChoice | null
  nowUnixMs: number
}): AgentActivityInteraction {
  const { approval, nowUnixMs } = input
  const title =
    approval.description ||
    approval.tool ||
    (approval.command ? 'Command approval' : 'Approval')
  const detail = approval.command || approval.description || approval.tool
  const actions = approval.choices.map((choice) => ({
    id: choice,
    label: CHOICE_LABELS[choice],
    semantic: CHOICE_SEMANTIC[choice],
  }))

  return {
    agentSessionId: input.agentSessionId,
    turnId: input.turnId,
    requestId: approval.approvalId,
    kind: 'approval',
    status: input.status ?? 'pending',
    toolName: approval.tool || 'terminal',
    input: {
      toolCall: {
        title,
        name: approval.tool || 'terminal',
        input: {
          command: approval.command,
          description: approval.description,
          pattern_key: approval.patternKey,
          pattern_keys: approval.patternKeys,
          risk_level: approval.riskLevel,
        },
      },
      options: approval.choices.map((choice) => ({
        optionId: choice,
        name: CHOICE_LABELS[choice],
        kind:
          choice === 'deny'
            ? 'deny'
            : choice === 'always'
              ? 'approve_always'
              : 'allow_once',
      })),
    },
    metadata: {
      hermesRunId: approval.runId,
      approvalId: approval.approvalId,
      rawApprovalIdPresent: approval.rawApprovalIdPresent,
      allowPermanent: approval.allowPermanent,
      actions,
      ...(input.choice ? { choice: input.choice } : {}),
    },
    output: input.choice
      ? { choice: input.choice, answers: [CHOICE_LABELS[input.choice]] }
      : null,
    createdAtUnixMs: nowUnixMs,
    updatedAtUnixMs: nowUnixMs,
  }
}

/** Client → Workspace approval body helper. */
export function hermesApprovalRespondBody(input: {
  choice: HermesApprovalChoice
  approvalId: string
  profileName?: string | null
}): Record<string, unknown> {
  return {
    choice: input.choice,
    approval_id: input.approvalId,
    ...(input.profileName?.trim()
      ? { profileName: input.profileName.trim() }
      : {}),
  }
}

export function readHermesRunIdFromInteraction(
  interaction: AgentActivityInteraction | null | undefined,
): string {
  if (!interaction) return ''
  const meta = readRecord(interaction.metadata)
  return (
    readString(meta?.hermesRunId) ||
    readString(meta?.runId) ||
    readString(meta?.run_id)
  )
}
