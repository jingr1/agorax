/**
 * Parse Claude Code `--output-format stream-json` NDJSON into display-channel
 * events. Prefer `--include-partial-messages` deltas; fall back to full
 * `assistant` message text when partials are absent (avoids double-emitting).
 */

export type ClaudeParsedEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool'
      phase: 'start' | 'end'
      name: string
      args?: unknown
    }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'session'; sessionId: string }

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export class ClaudeStreamJsonParser {
  private buffer = ''
  private sawPartialText = false
  private toolsById = new Map<string, string>()

  push(chunk: string): Array<ClaudeParsedEvent> {
    this.buffer += chunk
    const events: Array<ClaudeParsedEvent> = []
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.trim()) continue
      events.push(...this.handleLine(line))
    }
    return events
  }

  /** Flush a trailing non-newline-terminated buffer (process exit). */
  flush(): Array<ClaudeParsedEvent> {
    const rest = this.buffer
    this.buffer = ''
    if (!rest.trim()) return []
    return this.handleLine(rest.replace(/\r$/, ''))
  }

  private handleLine(line: string): Array<ClaudeParsedEvent> {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      // Plain-text fallback (tests / older CLI modes).
      return [{ type: 'text_delta', text: line.endsWith('\n') ? line : `${line}\n` }]
    }
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      return [{ type: 'text_delta', text: `${line}\n` }]
    }
    const obj = asObject(raw)
    if (!obj) return []
    return this.handleObject(obj)
  }

  private handleObject(obj: JsonObject): Array<ClaudeParsedEvent> {
    const type = asString(obj.type)
    if (!type) return []

    const events: Array<ClaudeParsedEvent> = []
    const sessionId = asString(obj.session_id)?.trim()
    if (sessionId) {
      events.push({ type: 'session', sessionId })
    }

    if (type === 'stream_event') {
      const event = asObject(obj.event)
      if (event) events.push(...this.handleStreamEvent(event))
      return events
    }

    if (type === 'assistant') {
      events.push(...this.handleAssistantMessage(asObject(obj.message)))
      return events
    }

    if (type === 'user') {
      events.push(...this.handleUserMessage(asObject(obj.message)))
      return events
    }

    if (type === 'result') {
      events.push(...this.handleResult(obj))
      return events
    }

    if (type === 'system') {
      const subtype = asString(obj.subtype)
      if (subtype === 'init') {
        const model = asString(obj.model)
        events.push({
          type: 'thinking',
          text: model
            ? `Claude Code started (${model})`
            : 'Claude Code started',
        })
      } else if (subtype === 'api_retry') {
        // Claude Code retries HTTP 429 internally (often max_retries=10) with
        // exponential backoff. Permanent quota exhaustion from proxy gateways
        // is reported as rate_limit — fail fast instead of hanging for minutes.
        const status =
          typeof obj.error_status === 'number' ? obj.error_status : Number(obj.error_status)
        const errName = (asString(obj.error) ?? '').trim() || 'rate_limit'
        if (status === 429 || errName.toLowerCase() === 'rate_limit') {
          const attempt =
            typeof obj.attempt === 'number' ? obj.attempt : Number(obj.attempt)
          const maxRetries =
            typeof obj.max_retries === 'number'
              ? obj.max_retries
              : Number(obj.max_retries)
          const code = Number.isFinite(status) && status > 0 ? status : 429
          let message = `API Error: Request rejected (${code}) · ${errName}`
          if (Number.isFinite(attempt) && attempt > 0 && Number.isFinite(maxRetries) && maxRetries > 0) {
            message = `${message} (retry ${attempt}/${maxRetries} aborted)`
          }
          events.push({ type: 'error', message, fatal: true })
        }
      }
      return events
    }

    return events
  }

  private handleStreamEvent(event: JsonObject): Array<ClaudeParsedEvent> {
    const eventType = asString(event.type)
    if (eventType === 'content_block_delta') {
      const delta = asObject(event.delta)
      if (!delta) return []
      const deltaType = asString(delta.type)
      if (deltaType === 'text_delta') {
        const text = asString(delta.text) ?? ''
        if (!text) return []
        this.sawPartialText = true
        return [{ type: 'text_delta', text }]
      }
      if (deltaType === 'thinking_delta') {
        const text =
          asString(delta.thinking) ?? asString(delta.text) ?? ''
        if (!text) return []
        return [{ type: 'thinking', text }]
      }
      return []
    }

    if (eventType === 'content_block_start') {
      const block = asObject(event.content_block)
      if (!block) return []
      const blockType = asString(block.type)
      if (blockType === 'tool_use') {
        const name = asString(block.name) || 'tool'
        const id = asString(block.id)
        if (id) this.toolsById.set(id, name)
        return [
          {
            type: 'tool',
            phase: 'start',
            name,
            args: block.input,
          },
        ]
      }
      if (blockType === 'thinking') {
        return [{ type: 'thinking', text: 'Thinking…' }]
      }
      return []
    }

    if (eventType === 'content_block_stop') {
      // tool_use block stop = args finished streaming, not tool finished.
      // Wait for user/tool_result for phase:'end'.
      return []
    }

    return []
  }

  private handleAssistantMessage(
    message: JsonObject | null,
  ): Array<ClaudeParsedEvent> {
    if (!message) return []
    const content = message.content
    if (!Array.isArray(content)) return []
    const events: Array<ClaudeParsedEvent> = []
    for (const item of content) {
      const block = asObject(item)
      if (!block) continue
      const blockType = asString(block.type)
      if (blockType === 'text') {
        // Partials already streamed this text — skip duplicate dump.
        if (this.sawPartialText) continue
        const text = asString(block.text)
        if (text) events.push({ type: 'text_delta', text })
      } else if (blockType === 'tool_use') {
        const name = asString(block.name) || 'tool'
        const id = asString(block.id)
        if (id) this.toolsById.set(id, name)
        events.push({
          type: 'tool',
          phase: 'start',
          name,
          args: block.input,
        })
      } else if (blockType === 'thinking') {
        const text = asString(block.thinking) ?? asString(block.text)
        if (text) events.push({ type: 'thinking', text })
      }
    }
    return events
  }

  private handleUserMessage(
    message: JsonObject | null,
  ): Array<ClaudeParsedEvent> {
    if (!message) return []
    const content = message.content
    if (!Array.isArray(content)) return []
    const events: Array<ClaudeParsedEvent> = []
    for (const item of content) {
      const block = asObject(item)
      if (!block) continue
      if (asString(block.type) !== 'tool_result') continue
      const id = asString(block.tool_use_id)
      const name = (id && this.toolsById.get(id)) || 'tool'
      if (id) this.toolsById.delete(id)
      events.push({ type: 'tool', phase: 'end', name })
    }
    return events
  }

  private handleResult(obj: JsonObject): Array<ClaudeParsedEvent> {
    const isError =
      obj.is_error === true || asString(obj.subtype) === 'error'
    const resultText = asString(obj.result) ?? asString(obj.error)
    if (isError) {
      return [
        {
          type: 'error',
          message: resultText?.trim() || 'Claude Code run failed',
        },
      ]
    }
    // Final result string often duplicates streamed assistant text.
    if (!this.sawPartialText && resultText?.trim()) {
      return [{ type: 'text_delta', text: resultText }]
    }
    return []
  }
}

/** Ensure print-mode argv emits stream-json with partial token events. */
export function withStreamJsonOutput(args: Array<string>): Array<string> {
  const out = [...args]
  const hasOutputFormat = out.includes('--output-format')
  if (!hasOutputFormat) {
    out.push('--output-format', 'stream-json')
  }
  if (!out.includes('--verbose')) {
    out.push('--verbose')
  }
  if (!out.includes('--include-partial-messages')) {
    out.push('--include-partial-messages')
  }
  return out
}

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    void import('./router').then((mod) => {
      mod.resetAgentRuntimeRouter()
    })
  })
}
