import type { AgentStreamEvent } from './types'
import type {
  AgentActivityEventMessage,
  AgentActivityUpdatedEvent,
} from '@agorax/agent-activity-core'

export type AgoraxManagedAgentActivity = AgentActivityUpdatedEvent

/**
 * Pull visible assistant text out of a durable message_update row.
 * Providers often land quota/API failures here (status=failed) without
 * ever emitting streaming message_delta frames.
 */
export function assistantTextFromActivityMessage(
  message: AgentActivityEventMessage | Record<string, unknown>,
): string {
  const role = String(
    (message as { role?: unknown }).role ?? '',
  ).toLowerCase()
  if (role !== 'assistant') return ''
  const payload = (message as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ''
  }
  const record = payload as Record<string, unknown>
  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text.trim()
  }
  const content = record.content
  if (Array.isArray(content)) {
    const parts: Array<string> = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
    return parts.join('\n').trim()
  }
  return ''
}

/** Latest assistant text snapshot from a message_update activity payload. */
export function assistantTextFromMessageUpdate(
  activity: AgoraxManagedAgentActivity,
): string {
  if (activity.eventType !== 'message_update') return ''
  const messages = activity.data.messages ?? []
  let latest = ''
  for (const message of messages) {
    const text = assistantTextFromActivityMessage(message)
    if (text) latest = text
  }
  return latest
}

function turnErrorMessage(activity: AgoraxManagedAgentActivity): string {
  if (activity.eventType !== 'turn_update') return ''
  const turn = activity.data.turn as {
    error?: { message?: unknown } | null
  }
  const message = turn?.error?.message
  return typeof message === 'string' ? message.trim() : ''
}

/**
 * Converts only canonical Managed Agent activity facts into the legacy stream shape
 * consumed by the current Agorax chat shell. Unknown activity is ignored so
 * the adapter cannot invent provider output or terminal state.
 */
export function agoraxEventsFromManagedActivity(
  runId: string,
  activity: AgoraxManagedAgentActivity,
  workspaceId = 'default',
): AgentStreamEvent[] {
  const canonicalEvent: AgentStreamEvent = {
    type: 'activity',
    runId,
    workspaceId,
    activity,
  }
  if (activity.eventType === 'message_delta') {
    const content = activity.data.content
    const text = content?.operation === 'append_text' ? content.text : ''
    if (activity.data.role === 'assistant' && text) {
      return [canonicalEvent, { type: 'text_delta', runId, text }]
    }
    return [canonicalEvent]
  }

  // Durable snapshots (including failed assistant rows that carry the provider
  // error text). Drain treats these as replace-snapshots via activity events.
  if (activity.eventType === 'message_update') {
    return [canonicalEvent]
  }

  if (activity.eventType !== 'turn_update') return [canonicalEvent]
  if (activity.data.turn.phase !== 'settled') return [canonicalEvent]
  const outcome = activity.data.turn.outcome
  if (!outcome) return [canonicalEvent]
  const events: AgentStreamEvent[] = [canonicalEvent]
  const err = turnErrorMessage(activity)
  if (err) {
    events.push({ type: 'error', runId, message: err })
  }
  events.push({
    type: 'run_exited',
    runId,
    exitCode: outcome === 'completed' ? 0 : 1,
  })
  return events
}
