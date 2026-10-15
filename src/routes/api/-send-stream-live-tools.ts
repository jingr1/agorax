type SyntheticLiveToolTracker = {
  emittedPhaseByToolCallId: Map<string, 'calling' | 'complete' | 'error'>
}

type CollectSyntheticLiveToolEventsParams = {
  messages: Array<Record<string, unknown>>
  tracker: SyntheticLiveToolTracker
  sessionKey: string
  runId?: string
}

type SyntheticLiveToolEvent = {
  phase: 'calling' | 'complete' | 'error'
  name: string
  toolCallId: string
  args?: unknown
  result?: string
  sessionKey: string
  runId?: string
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function parseJsonIfPossible(value: unknown): unknown {
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

function extractToolResultText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      const record = readRecord(part)
      return typeof record?.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Tool calls already sitting on a gateway event payload. Emits `calling`
 * through the same tracker as the session poll, so a later poll does not
 * open a second card for the same id.
 */
export function collectGatewayPayloadToolEvents(params: {
  data: Record<string, unknown>
  tracker: SyntheticLiveToolTracker
  sessionKey: string
  runId?: string
}): Array<SyntheticLiveToolEvent> {
  const message = readRecord(params.data.message)
  const lists = [
    params.data.tool_calls,
    params.data.toolCalls,
    message?.tool_calls,
    message?.toolCalls,
  ]
  const toolCalls = lists.find(
    (value): value is Array<Record<string, unknown>> =>
      Array.isArray(value) && value.length > 0,
  )
  if (!toolCalls) return []
  return collectSyntheticLiveToolEvents({
    messages: [{ role: 'assistant', tool_calls: toolCalls }],
    tracker: params.tracker,
    sessionKey: params.sessionKey,
    runId: params.runId,
  })
}

export function createSyntheticLiveToolTracker(): SyntheticLiveToolTracker {
  return {
    emittedPhaseByToolCallId: new Map(),
  }
}

export function collectSyntheticLiveToolEvents({
  messages,
  tracker,
  sessionKey,
  runId,
}: CollectSyntheticLiveToolEventsParams): Array<SyntheticLiveToolEvent> {
  const resultByCallId = new Map<string, { text: string; isError: boolean }>()
  const runToolCalls: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (!message) continue

    if (message.role === 'tool' || message.role === 'tool_result') {
      const callId =
        readString(message.tool_call_id) || readString(message.toolCallId)
      if (!callId) continue
      resultByCallId.set(callId, {
        text: extractToolResultText(message),
        isError: Boolean(message.is_error) || Boolean(message.isError),
      })
      continue
    }

    if (message.role === 'assistant') {
      const toolCalls = (message.tool_calls ?? message.toolCalls) as
        | Array<Record<string, unknown>>
        | undefined
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        runToolCalls.push(...toolCalls)
      }
    }
  }

  const events: Array<SyntheticLiveToolEvent> = []

  for (const toolCall of runToolCalls) {
    const toolFunction = readRecord(toolCall.function)
    const toolCallId =
      readString(toolCall.id) || readString(toolCall.tool_call_id) || ''
    if (!toolCallId) continue

    const name =
      readString(toolCall.tool_name) ||
      readString(toolCall.name) ||
      readString(toolFunction?.name) ||
      'tool'
    const args = parseJsonIfPossible(
      toolFunction?.arguments ?? toolCall.arguments,
    )
    const resultEntry = resultByCallId.get(toolCallId)
    const nextPhase = resultEntry
      ? resultEntry.isError
        ? 'error'
        : 'complete'
      : 'calling'
    const previousPhase = tracker.emittedPhaseByToolCallId.get(toolCallId)
    const baseEvent = {
      name,
      toolCallId,
      args,
      sessionKey,
      runId,
    }

    if (!previousPhase) {
      events.push({
        ...baseEvent,
        phase: 'calling',
        result: undefined,
      })
      tracker.emittedPhaseByToolCallId.set(toolCallId, 'calling')
    }

    if (nextPhase === 'calling') continue

    const currentPhase = tracker.emittedPhaseByToolCallId.get(toolCallId)
    if (currentPhase === nextPhase) continue
    if (currentPhase === 'complete' || currentPhase === 'error') continue

    tracker.emittedPhaseByToolCallId.set(toolCallId, nextPhase)
    events.push({
      ...baseEvent,
      phase: nextPhase,
      result: resultEntry?.text || undefined,
    })
  }

  return events
}

/**
 * Best-effort reasoning text from agent session messages while a run is open.
 * Mirrors {@link collectSyntheticLiveToolEvents}: vanilla Hermes often persists
 * thinking on the session transcript before it emits live reasoning SSE.
 */
export function collectSyntheticLiveThinkingText(
  messages: Array<Record<string, unknown>>,
): string {
  const chunks: Array<string> = []

  for (const message of messages) {
    if (readString(message.role) !== 'assistant') continue

    for (const key of [
      'reasoning_content',
      'reasoning',
      'thinking',
    ] as const) {
      const topLevel = readString(message[key])
      if (topLevel) chunks.push(topLevel)
    }

    const content = message.content
    if (Array.isArray(content)) {
      for (const part of content) {
        const record = readRecord(part)
        if (!record) continue
        const type = readString(record.type)
        if (
          type !== 'thinking' &&
          type !== 'redacted_thinking' &&
          type !== 'reasoning' &&
          type !== 'reasoning_content'
        ) {
          continue
        }
        const text =
          readString(record.thinking) ||
          readString(record.text) ||
          readString(record.reasoning) ||
          readString(record.reasoning_content)
        if (text) chunks.push(text)
      }
    }
  }

  if (chunks.length === 0) return ''
  return chunks.reduce((best, next) => (next.length > best.length ? next : best))
}
