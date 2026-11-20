import { readString } from './send-input'

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

export function getToolName(data: Record<string, unknown>): string {
  const toolCall = readRecord(data.tool_call)
  const tool = readRecord(data.tool)
  const toolFunction = readRecord(toolCall?.function)
  const structured =
    readString(toolCall?.tool_name) ||
    readString(toolCall?.name) ||
    readString(toolFunction?.name) ||
    readString(tool?.name) ||
    readString(data.tool_name)
  if (structured) return structured
  // Hermes Agent sometimes sends the tool/name as a bare string
  // (e.g. '_thinking', 'reasoning.available'). Prefer `tool` so a reasoning
  // payload's `name` field (the actual thinking text) is not mistaken for a
  // tool name.
  if (typeof data.tool === 'string' && data.tool.trim()) {
    return data.tool.trim()
  }
  if (typeof data.name === 'string' && data.name.trim()) {
    return data.name.trim()
  }
  return 'tool'
}

export function extractReasoningFromToolProgress(
  data: Record<string, unknown>,
): string | null {
  const delta = readString(data.delta)
  const toolName = getToolName(data)
  const eventType = readString(data.event)
  const isReasoning =
    toolName === '_thinking' ||
    toolName === 'reasoning.available' ||
    eventType === 'reasoning.available' ||
    eventType === '_thinking' ||
    eventType === 'reasoning.delta'
  if (!isReasoning) return null
  return (
    readString(data.preview) ||
    (eventType === 'reasoning.available' || eventType === 'reasoning.delta'
      ? ''
      : readString(data.name)) ||
    delta ||
    null
  )
}

export function extractReasoningFromGatewayEvent(
  event: string,
  data: Record<string, unknown>,
): string | null {
  const normalized = event.trim().toLowerCase()
  const isReasoningEvent =
    normalized === 'reasoning.delta' ||
    normalized === 'reasoning.available' ||
    normalized === 'response.reasoning_text.delta' ||
    normalized === 'reasoning'
  if (!isReasoningEvent) return null

  const nestedDelta = readRecord(data.delta)
  return (
    readString(data.delta) ||
    readString(data.text) ||
    readString(data.preview) ||
    readString(data.reasoning_content) ||
    readString(data.reasoning) ||
    readString(data.content) ||
    (nestedDelta
      ? readString(nestedDelta.text) ||
        readString(nestedDelta.content) ||
        readString(nestedDelta.reasoning_content)
      : null) ||
    null
  )
}

export function getToolCallId(
  data: Record<string, unknown>,
  runId: string | undefined,
  toolName: string,
): string {
  const toolCall = readRecord(data.tool_call)
  const tool = readRecord(data.tool)
  return (
    readString(toolCall?.id) ||
    readString(tool?.id) ||
    readString(data.tool_call_id) ||
    readString(data.call_id) ||
    readString(data.id) ||
    `${runId || 'run'}:${toolName}`
  )
}

export function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

export function getToolArgs(data: Record<string, unknown>): unknown {
  const toolCall = readRecord(data.tool_call)
  const toolFunction = readRecord(toolCall?.function)
  return parseJsonIfPossible(
    toolCall?.arguments ?? toolFunction?.arguments ?? data.args,
  )
}

export function getToolResultPreview(data: Record<string, unknown>): string {
  const raw = data.result_preview ?? data.result ?? data.output ?? data.message
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return ''
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return String(raw)
  }
}
