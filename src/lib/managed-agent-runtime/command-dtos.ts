// Client-safe wire DTOs for the Managed Agent workspace command routes
// (POST /api/agents/:agentId/engine/activate, .../input, .../cancel,
// .../interactions/...). Both the server handlers (response contracts) and
// the browser command port (response parsing) derive from these interfaces;
// the `activity` field stays `unknown` because it is the daemon's PascalCase
// aggregate, mapped into canonical shapes by the daemon adapter on the
// consuming side.

/** Error envelope shared by every managed command route (non-2xx). */
export interface ManagedAgentCommandErrorDto {
  error: string
}

/** POST /api/agents/:agentId/engine/activate (2xx). */
export interface ManagedAgentActivateResponseDto {
  runId: string
  activity: unknown
}

/** POST /api/agents/:agentId/engine/session/:sessionId/input (2xx). */
export interface ManagedAgentInputResponseDto {
  result: unknown
  activity: unknown
}

/** POST /api/agents/:agentId/engine/session/:sessionId/turns/:turnId/cancel (2xx). */
export interface ManagedAgentCancelResponseDto {
  result: unknown
  activity: unknown
}

/** POST /api/agents/:agentId/interactions/:sessionId/:turnId/:requestId (2xx). */
export interface ManagedAgentInteractionResponseDto {
  result: unknown
  activity: unknown
}

export function managedAgentErrorMessageFromResponse(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error.trim() : null
}

export function managedAgentActivateResponseFromJson(value: unknown): ManagedAgentActivateResponseDto {
  const record = asResponseRecord(value, 'activation')
  if (typeof record.runId !== 'string' || !record.runId.trim()) {
    throw new Error('Managed Agent activation returned an invalid response')
  }
  return { runId: record.runId, activity: record.activity }
}

export function managedAgentInputResponseFromJson(value: unknown): ManagedAgentInputResponseDto {
  return {
    result: readResponseField(value, 'send', 'result'),
    activity: readResponseField(value, 'send', 'activity'),
  }
}

export function managedAgentCancelResponseFromJson(value: unknown): ManagedAgentCancelResponseDto {
  return {
    result: readResponseField(value, 'cancel', 'result'),
    activity: readResponseField(value, 'cancel', 'activity'),
  }
}

export function managedAgentInteractionResponseFromJson(value: unknown): ManagedAgentInteractionResponseDto {
  return {
    result: readResponseField(value, 'interaction response', 'result'),
    activity: readResponseField(value, 'interaction response', 'activity'),
  }
}

function readResponseField(value: unknown, operation: string, field: 'result' | 'activity'): unknown {
  const record = asResponseRecord(value, operation)
  if (!(field in record)) {
    throw new Error(`Managed Agent ${operation} returned an invalid response`)
  }
  return record[field]
}

function asResponseRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Managed Agent ${operation} returned an invalid response`)
  }
  return value as Record<string, unknown>
}

/**
 * Cancel state of the daemon `CancelTurnResult` (PascalCase wire field
 * `State`): `settled` reports the provider already confirmed the canceled
 * terminal; `requested` means the durable intent was accepted and canonical
 * settlement still needs to reconcile; `already_settled`/`not_found` are
 * idempotent no-ops. Unknown/absent shapes yield `null` so callers fall back
 * to snapshot-derived semantics instead of fabricating a state.
 */
export type ManagedAgentDaemonCancelState =
  | 'settled'
  | 'not_found'
  | 'already_settled'
  | 'requested'

export function managedAgentDaemonCancelStateFromResult(result: unknown): ManagedAgentDaemonCancelState | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const record = result as Record<string, unknown>
  const state = record.State ?? record.state
  return state === 'settled' ||
    state === 'not_found' ||
    state === 'already_settled' ||
    state === 'requested'
    ? state
    : null
}
