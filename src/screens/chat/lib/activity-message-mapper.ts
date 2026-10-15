/**
 * Single Activity row → ChatMessage (user/system/orphan tool/reasoning).
 * Turn-level fold lives in activity-list-projection.ts.
 */

import {
  thinkingContentFromText,
  thinkingTextFromPayload,
} from '@/lib/chat-message-parts'
import type { ChatMessage } from '../types'

/** Shared Activity → ChatMessage mapping (Hermes + managed singleton rows). */
export function activityMessageToChatMessage(message: {
  messageId: string
  role: string
  kind: string
  payload: Record<string, unknown>
  occurredAtUnixMs: number
  status?: string | null
  semantics?: {
    noticeCommand?: string
    noticeCommandStatus?: string
  } | null
}): ChatMessage {
  const notice = noticeCommandSystemLine(message.semantics)
  if (notice) {
    return {
      role: 'system',
      content: [{ type: 'text', text: notice }],
      timestamp: message.occurredAtUnixMs,
    }
  }
  if (isToolCallKind(message.kind)) {
    const error = firstNonEmptyString(
      message.payload.error,
      message.payload.errorMessage,
    )
    const rawOutput = message.payload.output
    return {
      id: message.messageId,
      role: message.role,
      content: [
        {
          type: 'toolCall',
          id: message.messageId,
          name: toolNameFromPayload(message.payload),
          arguments: record(message.payload.input ?? message.payload.arguments),
        },
      ],
      timestamp: message.occurredAtUnixMs,
      toolName: toolNameFromPayload(message.payload),
      details: {
        input: record(message.payload.input ?? message.payload.arguments),
        ...(rawOutput != null ? { output: rawOutput } : {}),
        ...(error ? { error } : {}),
      },
      ...(message.status === 'failed' || error ? { isError: true } : {}),
    }
  }
  if (message.kind === 'reasoning' || message.role === 'assistant_thinking') {
    const thinkingPart = thinkingContentFromText(
      thinkingTextFromPayload(message.payload),
    )
    return {
      id: message.messageId,
      role: 'assistant',
      content: thinkingPart ? [thinkingPart] : [],
      timestamp: message.occurredAtUnixMs,
      ...(message.status === 'failed' ? { isError: true } : {}),
    }
  }
  const text =
    message.kind === 'text'
      ? visibleUserOrAssistantText(message.role, message.payload)
      : typeof message.payload.text === 'string'
        ? message.payload.text
        : ''
  return {
    id: message.messageId,
    role: message.role,
    content: [{ type: 'text', text }],
    timestamp: message.occurredAtUnixMs,
    ...(message.status === 'failed' ? { isError: true } : {}),
  }
}

/** Visible assistant/user text for kind=text rows (errors, displayPrompt, …). */
export function visibleTextFromActivityPayload(
  role: string,
  payload: Record<string, unknown>,
): string {
  return visibleUserOrAssistantText(role, payload)
}

export function visibleErrorText(payload: Record<string, unknown>): string {
  if (payload.kind !== 'agent_visible_error') {
    return typeof payload.text === 'string' ? payload.text : ''
  }
  const origin = typeof payload.origin === 'string' ? payload.origin : ''
  const detail = typeof payload.detail === 'string' ? payload.detail.trim() : ''
  if (origin === 'provider' && detail) return detail
  for (const key of ['text', 'content', 'detail', 'errorMessage', 'error']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

export function systemNoticeText(payload: Record<string, unknown>): string {
  for (const key of ['detail', 'content', 'errorMessage', 'error', 'text']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function visibleUserOrAssistantText(
  role: string,
  payload: Record<string, unknown>,
): string {
  if (role === 'user') {
    const display = firstNonEmptyString(payload.displayPrompt)
    if (display) return display
  }
  return visibleErrorText(payload)
}

function isToolCallKind(kind: string): boolean {
  return kind === 'tool_call' || kind === 'tool'
}

function toolNameFromPayload(payload: Record<string, unknown>): string {
  const toolName = firstNonEmptyString(payload.toolName, payload.name)
  return toolName ?? 'Tool'
}

function firstNonEmptyString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function noticeCommandSystemLine(
  semantics:
    | {
        noticeCommand?: string
        noticeCommandStatus?: string
      }
    | null
    | undefined,
): string | null {
  const command = semantics?.noticeCommand?.trim()
  if (!command) return null
  const status = semantics?.noticeCommandStatus?.trim()
  const labels: Record<string, string> = {
    compact: 'Compacting context',
    review: 'Reviewing changes',
    undo: 'Undoing last action',
    goal: 'Updating goal',
  }
  const label = labels[command] ?? command
  if (!status || status === 'running' || status === 'started') {
    return `${label}…`
  }
  if (status === 'completed' || status === 'succeeded') {
    return `${label} complete`
  }
  if (status === 'failed' || status === 'error') {
    return `${label} failed`
  }
  return `${label} (${status})`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
