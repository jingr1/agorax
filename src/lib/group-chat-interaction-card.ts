/**
 * Client-safe codec for group-chat managed interaction cards.
 *
 * A card is a regular room message whose content is a human-readable summary
 * line plus an HTML-comment JSON block carrying the canonical daemon
 * interaction verbatim (ids, status, input/metadata/output). Both the server
 * (turn-executor projection + writeback refresh) and the UI (card renderer)
 * read/write through these helpers so the wire shape never drifts.
 *
 * The card status is ALWAYS the canonical interaction status — this codec
 * holds no pending state of its own.
 */
import type { AgentActivityInteraction } from '@agorax/agent-activity-core'

export const MANAGED_INTERACTION_CARD_MARKER = 'agorax:managed-interaction:v1'

const CARD_BLOCK_RE = /<!--agorax:managed-interaction:v1\s*\n([\s\S]*?)\n-->/

export type ManagedInteractionCardPayload = {
  agentSessionId: string
  turnId: string
  requestId: string
  kind: AgentActivityInteraction['kind']
  status: AgentActivityInteraction['status']
  toolName: string | null
  /** Canonical interaction payload, verbatim — the UI re-projects it. */
  input: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  output: Record<string, unknown> | null
}

export function encodeManagedInteractionCard(
  payload: ManagedInteractionCardPayload,
): string {
  return `${cardSummary(payload)}\n\n<!--${MANAGED_INTERACTION_CARD_MARKER}\n${JSON.stringify(payload, null, 2)}\n-->`
}

export function decodeManagedInteractionCard(
  content: string,
): ManagedInteractionCardPayload | null {
  const match = CARD_BLOCK_RE.exec(content)
  if (!match?.[1]) return null
  try {
    const raw = JSON.parse(match[1]) as Partial<ManagedInteractionCardPayload>
    if (
      typeof raw.agentSessionId !== 'string' ||
      typeof raw.turnId !== 'string' ||
      typeof raw.requestId !== 'string' ||
      (raw.kind !== 'approval' &&
        raw.kind !== 'question' &&
        raw.kind !== 'plan') ||
      (raw.status !== 'pending' &&
        raw.status !== 'answered' &&
        raw.status !== 'superseded')
    ) {
      return null
    }
    return {
      agentSessionId: raw.agentSessionId,
      turnId: raw.turnId,
      requestId: raw.requestId,
      kind: raw.kind,
      status: raw.status,
      toolName: typeof raw.toolName === 'string' ? raw.toolName : null,
      input: record(raw.input),
      metadata: record(raw.metadata),
      output: record(raw.output),
    }
  } catch {
    return null
  }
}

export function cardSummary(payload: ManagedInteractionCardPayload): string {
  const toolCall = record(record(payload.input)?.toolCall)
  const title = text(toolCall?.title) || payload.toolName || payload.kind
  switch (payload.kind) {
    case 'approval':
      return `[Needs approval] ${title}`
    case 'question':
      return `[Question] ${title}`
    case 'plan':
      return `[Plan] ${title}`
    default:
      return `[Interaction] ${title}`
  }
}

export function cardPayloadFromCanonical(
  interaction: AgentActivityInteraction,
): ManagedInteractionCardPayload {
  return {
    agentSessionId: interaction.agentSessionId,
    turnId: interaction.turnId,
    requestId: interaction.requestId,
    kind: interaction.kind,
    status: interaction.status,
    toolName: interaction.toolName ?? null,
    input: interaction.input ?? null,
    metadata: interaction.metadata ?? null,
    output: interaction.output ?? null,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}
