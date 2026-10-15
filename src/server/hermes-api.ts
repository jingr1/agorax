/**
 * Hermes Agent FastAPI Client
 *
 * HTTP client for the Hermes Agent FastAPI backend (default: http://127.0.0.1:8642).
 * Replaces legacy WebSocket connection for the Agorax fork.
 */

import {
  normalizeChatContentParts,
  storedMessageContentToText,
} from '../lib/chat-message-parts'
import { resolveChatGateway } from './chat-gateway'
import {
  HERMES_API,
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  dashboardFetch,
  ensureGatewayCoreProbed,
  ensureGatewayProbed,
  ensureSessionsCapability,
  getCapabilities,
  getGatewayBearerToken,
  probeGateway,
} from './gateway-capabilities'
import {
  createSession as createDashboardSession,
  deleteSession as deleteDashboardSession,
  forkSession as forkDashboardSession,
  getSession as getDashboardSession,
  getSessionMessages as getDashboardSessionMessages,
  listSessions as listDashboardSessions,
  searchSessions as searchDashboardSessions,
  updateSession as updateDashboardSession,
} from './hermes-dashboard-api'

const _authHeaders = (): Record<string, string> => {
  const token = resolveChatGateway().token || getGatewayBearerToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function gatewayUrl(path: string): string {
  return `${resolveChatGateway().url}${path}`
}

console.log(`[hermes-api] Configured API: ${HERMES_API}`)

// ── Types ─────────────────────────────────────────────────────────

export type HermesSession = {
  id: string
  source?: string
  user_id?: string | null
  model?: string | null
  title?: string | null
  started_at?: number
  ended_at?: number | null
  end_reason?: string | null
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  parent_session_id?: string | null
  last_active?: number | null
  preview?: string | null
}

export type HermesMessage = {
  id: number
  session_id: string
  role: string
  /** Plain text, JSON content-block array, or already-parsed blocks. */
  content: string | Array<unknown> | null
  tool_call_id?: string | null
  tool_calls?: Array<unknown> | string | null
  tool_name?: string | null
  timestamp: number
  token_count?: number | null
  finish_reason?: string | null
}

export type HermesConfig = {
  model?: string
  provider?: string
  [key: string]: unknown
}

// ── Helpers ───────────────────────────────────────────────────────

async function hermesGet<T>(path: string): Promise<T> {
  const res = await fetch(gatewayUrl(path), { headers: _authHeaders() })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Hermes Agent API ${path}: ${res.status} ${body}`)
  }
  return res.json() as Promise<T>
}

async function hermesPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(gatewayUrl(path), {
    method: 'POST',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes Agent API POST ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function hermesPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(gatewayUrl(path), {
    method: 'PATCH',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes Agent API PATCH ${path}: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

async function hermesDeleteReq(path: string): Promise<void> {
  const res = await fetch(gatewayUrl(path), {
    method: 'DELETE',
    headers: _authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes Agent API DELETE ${path}: ${res.status} ${text}`)
  }
}

// ── Health ────────────────────────────────────────────────────────

export async function checkHealth(): Promise<{ status: string }> {
  return hermesGet('/health')
}

// ── Sessions ─────────────────────────────────────────────────────

/**
 * @deprecated Control-plane refactor: sessions are served from state.db
 * or the profile gateway. Dashboard sessions path is disabled.
 */
function useDashboardSessions(): boolean {
  return false
}

export async function listSessions(
  limit = 50,
  offset = 0,
): Promise<Array<HermesSession>> {
  if (useDashboardSessions()) {
    const resp = await listDashboardSessions(limit, offset)
    return resp.sessions as Array<HermesSession>
  }
  const resp = await hermesGet<{
    items?: Array<HermesSession>
    data?: Array<HermesSession>
    total?: number
  }>(`/api/sessions?limit=${limit}&offset=${offset}`)
  // The gateway (OpenAI-compat) returns { object: 'list', data: [...] }, while the
  // dashboard / older gateway shape uses { items: [...] }. Accept either, and never
  // return undefined (callers .map over this).
  return resp.items ?? resp.data ?? []
}

export async function getSession(sessionId: string): Promise<HermesSession> {
  if (useDashboardSessions()) {
    return getDashboardSession(sessionId) as Promise<HermesSession>
  }
  const resp = await hermesGet<{ session: HermesSession }>(
    `/api/sessions/${sessionId}`,
  )
  return resp.session
}

export async function createSession(opts?: {
  id?: string
  title?: string
  model?: string
}): Promise<HermesSession> {
  if (useDashboardSessions()) {
    const resp = await createDashboardSession(opts || {})
    return resp.session as HermesSession
  }
  const resp = await hermesPost<{
    session?: HermesSession
    data?: HermesSession
    id?: string
  }>('/api/sessions', opts || {})
  const session = resp.session ?? resp.data ?? (resp as HermesSession)
  if (!session?.id) {
    if (opts?.id) {
      return { id: opts.id, title: opts.title, model: opts.model }
    }
    throw new Error('Invalid session response')
  }
  return session
}

export async function updateSession(
  sessionId: string,
  updates: { title?: string },
): Promise<HermesSession> {
  if (useDashboardSessions()) {
    const resp = await updateDashboardSession(sessionId, updates)
    return resp.session as HermesSession
  }
  const resp = await hermesPatch<{ session: HermesSession }>(
    `/api/sessions/${sessionId}`,
    updates,
  )
  return resp.session
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (useDashboardSessions()) {
    await deleteDashboardSession(sessionId)
    return
  }
  return hermesDeleteReq(`/api/sessions/${sessionId}`)
}

export async function getMessages(
  sessionId: string,
): Promise<Array<HermesMessage>> {
  if (useDashboardSessions()) {
    const resp = await getDashboardSessionMessages(sessionId)
    return resp.messages as Array<HermesMessage>
  }
  const resp = await hermesGet<{
    items?: Array<HermesMessage>
    data?: Array<HermesMessage>
    messages?: Array<HermesMessage>
    total?: number
  }>(`/api/sessions/${sessionId}/messages`)
  // Gateway (OpenAI-compat) returns { object: 'list', data: [...] }; dashboard / older
  // shape uses { items: [...] }; some message endpoints use { messages: [...] }.
  // Accept any, and never return undefined (callers read .length / .map / .slice).
  return resp.items ?? resp.data ?? resp.messages ?? []
}

export async function searchSessions(
  query: string,
  limit = 20,
): Promise<{ query?: string; count?: number; results: Array<unknown> }> {
  if (useDashboardSessions()) {
    return searchDashboardSessions(query)
  }
  return hermesGet(
    `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  )
}

export async function forkSession(
  sessionId: string,
): Promise<{ session: HermesSession; forked_from: string }> {
  if (useDashboardSessions()) {
    return forkDashboardSession(sessionId) as Promise<{
      session: HermesSession
      forked_from: string
    }>
  }
  return hermesPost(`/api/sessions/${sessionId}/fork`)
}

export async function truncateSession(
  sessionId: string,
  keepCount: number,
): Promise<{ keep_count: number; removed_count: number }> {
  if (!Number.isInteger(keepCount) || keepCount < 0) {
    throw new Error('keepCount must be a non-negative integer')
  }
  if (useDashboardSessions()) {
    throw new Error('Session truncate is not available on dashboard sessions')
  }
  const resp = await hermesPost<{
    keep_count?: number
    removed_count?: number
  }>(`/api/sessions/${sessionId}/truncate`, { keep_count: keepCount })
  return {
    keep_count: resp.keep_count ?? keepCount,
    removed_count: resp.removed_count ?? 0,
  }
}

/** Apply a precomputed compression summary + keep trailing messages. */
export async function compressSession(
  sessionId: string,
  input: { summary: string; keepCount?: number; focusTopic?: string },
): Promise<{
  before_count: number
  after_count: number
  keep_count: number
  summary: string
  focus_topic: string | null
}> {
  const summary = input.summary.trim()
  if (!summary) throw new Error('summary required')
  if (useDashboardSessions()) {
    throw new Error('Session compress is not available on dashboard sessions')
  }
  return hermesPost(`/api/sessions/${sessionId}/compress`, {
    summary,
    keep_count: input.keepCount ?? 6,
    focus_topic: input.focusTopic || undefined,
  })
}

/** Stateless chat completion (no session write) — used for /btw and compress summary. */
export async function oneshotCompletion(input: {
  messages: Array<{ role: string; content: string }>
  model?: string
}): Promise<string> {
  const resp = await hermesPost<{
    choices?: Array<{ message?: { content?: string } }>
    message?: { content?: string }
    content?: string
  }>('/v1/chat/completions', {
    messages: input.messages,
    model: input.model,
    stream: false,
  })
  const text =
    resp.choices?.[0]?.message?.content ||
    resp.message?.content ||
    (typeof resp.content === 'string' ? resp.content : '')
  return String(text || '').trim()
}

/** Inject mid-turn guidance into a live Hermes run. */
export async function steerRun(
  runId: string,
  text: string,
): Promise<{ accepted: boolean; run_id: string }> {
  const trimmedRunId = runId.trim()
  const trimmedText = text.trim()
  if (!trimmedRunId) throw new Error('runId required')
  if (!trimmedText) throw new Error('steer text required')
  return hermesPost(`/v1/runs/${encodeURIComponent(trimmedRunId)}/steer`, {
    text: trimmedText,
  })
}

/** Interrupt a durable Hermes `/v1/runs/{id}` turn (best-effort). */
export async function stopRun(
  runId: string,
): Promise<{ run_id: string; status: string }> {
  const trimmedRunId = runId.trim()
  if (!trimmedRunId) throw new Error('runId required')
  return hermesPost(`/v1/runs/${encodeURIComponent(trimmedRunId)}/stop`, {})
}

/**
 * Resolve a pending dangerous-command / trust-gate approval for a live run.
 * Gateway contract: POST /v1/runs/{run_id}/approval
 * body `{ choice: once|session|always|deny, approval_id? }`
 */
export async function respondRunApproval(
  runId: string,
  input: { choice: string; approvalId?: string | null },
): Promise<Record<string, unknown>> {
  const trimmedRunId = runId.trim()
  const choice = String(input.choice || '').trim().toLowerCase()
  if (!trimmedRunId) throw new Error('runId required')
  if (!choice) throw new Error('choice required')
  const approvalId = String(input.approvalId || '').trim()
  return hermesPost(
    `/v1/runs/${encodeURIComponent(trimmedRunId)}/approval`,
    {
      choice,
      ...(approvalId ? { approval_id: approvalId } : {}),
    },
  )
}

// ── Conversion helpers (Claude → Chat format) ─────────────────

/** Convert a HermesMessage to the ChatMessage format the frontend expects */
export function toChatMessage(
  msg: HermesMessage,
  options?: { historyIndex?: number },
): Record<string, unknown> {
  // Accept either parsed arrays from FastAPI or legacy JSON strings.
  let toolCalls: Array<unknown> | undefined
  if (Array.isArray(msg.tool_calls)) {
    toolCalls = msg.tool_calls
  } else if (msg.tool_calls && typeof msg.tool_calls === 'string') {
    try {
      toolCalls = JSON.parse(msg.tool_calls)
    } catch {
      toolCalls = undefined
    }
  }

  // Build content array — shared normalizer keeps Hermes thinking parts in the
  // same shape managed ACP uses (`{ type: 'thinking', thinking }`).
  const content: Array<Record<string, unknown>> = []

  // Build streamToolCalls array for separate pill rendering and content blocks
  const streamToolCallsArr: Array<Record<string, unknown>> = []
  if (msg.role === 'assistant' && toolCalls && Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const record = tc as Record<string, unknown>
      const fn = record.function as Record<string, unknown> | undefined
      const toolCallId =
        record.id || `tc-${Math.random().toString(36).slice(2, 8)}`
      const toolName = fn?.name || (record.name as string | undefined) || 'tool'
      const toolArgs = fn?.arguments
      streamToolCallsArr.push({
        id: toolCallId,
        name: toolName,
        args: toolArgs,
        phase: 'complete',
      })
      content.push({
        type: 'toolCall',
        id: toolCallId,
        name: toolName,
        arguments:
          toolArgs && typeof toolArgs === 'object'
            ? (toolArgs as Record<string, unknown>)
            : undefined,
        partialJson: typeof toolArgs === 'string' ? toolArgs : undefined,
      })
    }
  }

  if (msg.role === 'tool') {
    const toolText =
      typeof msg.content === 'string'
        ? msg.content
        : storedMessageContentToText(msg.content)
    content.push({
      type: 'tool_result',
      toolCallId: msg.tool_call_id,
      toolName: msg.tool_name,
      text: toolText || '',
    })
  } else if (msg.content != null && msg.content !== '') {
    content.push(
      ...normalizeChatContentParts(msg.content, {
        role: msg.role,
        extractInlineThinkingTags: msg.role === 'assistant',
      }),
    )
  }

  const visibleText = content
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')

  return {
    id: `msg-${msg.id}`,
    role: msg.role,
    content,
    text: visibleText,
    timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    createdAt: msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined,
    sessionKey: msg.session_id,
    ...(typeof options?.historyIndex === 'number'
      ? { __historyIndex: options.historyIndex }
      : {}),
    ...(streamToolCallsArr.length > 0
      ? { streamToolCalls: streamToolCallsArr }
      : {}),
  }
}

/** Convert a HermesSession to the session summary format the frontend expects */
export function toSessionSummary(
  session: HermesSession,
): Record<string, unknown> {
  return {
    key: session.id,
    friendlyId: session.id,
    kind: 'chat',
    status: session.ended_at ? 'ended' : 'idle',
    model: session.model || '',
    label: session.title || undefined,
    title: session.title || undefined,
    derivedTitle: session.title || session.preview || undefined,
    preview: session.preview || undefined,
    tokenCount: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    message_count: session.message_count ?? 0,
    tool_call_count: session.tool_call_count ?? 0,
    messageCount: session.message_count ?? 0,
    toolCallCount: session.tool_call_count ?? 0,
    cost: 0,
    createdAt: session.started_at ? session.started_at * 1000 : Date.now(),
    startedAt: session.started_at ? session.started_at * 1000 : Date.now(),
    updatedAt: session.last_active
      ? session.last_active * 1000
      : session.ended_at
        ? session.ended_at * 1000
        : session.started_at
          ? session.started_at * 1000
          : Date.now(),
    usage: {
      promptTokens: session.input_tokens ?? 0,
      completionTokens: session.output_tokens ?? 0,
      totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    },
  }
}

// ── Chat (streaming) ─────────────────────────────────────────────

type StreamChatOptions = {
  signal?: AbortSignal
  onEvent: (payload: {
    event: string
    data: Record<string, unknown>
  }) => void | Promise<void>
}

/**
 * Send a chat message and stream SSE events from Hermes Agent FastAPI.
 * Returns a promise that resolves when the stream ends.
 */
export async function streamChat(
  sessionId: string,
  body: {
    message: string
    model?: string
    system_message?: string
    attachments?: Array<Record<string, unknown>>
  },
  opts: StreamChatOptions,
): Promise<void> {
  const res = await fetch(gatewayUrl(`/api/sessions/${sessionId}/chat/stream`), {
    method: 'POST',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hermes chat stream: ${res.status} ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  // Debug tap: when HERMES_TOOL_DEBUG=1, dump every raw SSE event to a file so
  // we can inspect what vanilla Hermes Agent actually emits during tool calls
  // (event names + data shapes) without changing any agent code.
  const toolDebug = process.env.HERMES_TOOL_DEBUG === '1'
  let toolDebugStream: NodeJS.WritableStream | null = null
  if (toolDebug) {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const os = await import('node:os')
      const dir = path.join(os.tmpdir(), 'hermes-tool-debug')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `sse-${sessionId}-${Date.now()}.log`)
      toolDebugStream = fs.createWriteStream(file, { flags: 'a' })
      console.log(`[hermes-api][tool-debug] writing SSE dump to ${file}`)
      toolDebugStream.write(
        `# session=${sessionId} ts=${new Date().toISOString()}\n`,
      )
    } catch (err) {
      console.warn('[hermes-api][tool-debug] failed to open dump file:', err)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
        if (toolDebugStream) toolDebugStream.write(`event: ${currentEvent}\n`)
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6)
        if (dataStr === '[DONE]') {
          if (toolDebugStream) toolDebugStream.write('data: [DONE]\n\n')
          continue
        }
        if (toolDebugStream) {
          // Truncate very long payloads so the dump stays human-readable.
          const trimmed =
            dataStr.length > 4000
              ? dataStr.slice(0, 4000) + '...[trunc]'
              : dataStr
          toolDebugStream.write(`data: ${trimmed}\n\n`)
        }
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>
          await opts.onEvent({ event: currentEvent || 'message', data })
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
  if (toolDebugStream) {
    try {
      toolDebugStream.end()
    } catch {
      // ignore close errors
    }
  }
}

/** Non-streaming chat */
export async function sendChat(
  sessionId: string,
  messageOrOpts: string | { message: string; model?: string },
  model?: string,
): Promise<Record<string, unknown>> {
  const msg =
    typeof messageOrOpts === 'string' ? messageOrOpts : messageOrOpts.message
  const mdl = typeof messageOrOpts === 'string' ? model : messageOrOpts.model
  return hermesPost(`/api/sessions/${sessionId}/chat`, {
    message: msg,
    model: mdl,
  })
}

// ── Memory ───────────────────────────────────────────────────────

export async function getMemory(): Promise<unknown> {
  return hermesGet('/api/memory')
}

// ── Skills ───────────────────────────────────────────────────────

export async function listSkills(): Promise<unknown> {
  return hermesGet('/api/skills')
}

export async function getSkill(name: string): Promise<unknown> {
  return hermesGet(`/api/skills/${encodeURIComponent(name)}`)
}

export async function getSkillCategories(): Promise<unknown> {
  return hermesGet('/api/skills/categories')
}

// ── Config ───────────────────────────────────────────────────────

export async function getConfig(): Promise<HermesConfig> {
  // Control-plane refactor: prefer gateway, dashboard is optional fallback
  return hermesGet<HermesConfig>('/api/config')
}

export async function patchConfig(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Control-plane refactor: prefer gateway, dashboard is optional fallback
  return hermesPatch<Record<string, unknown>>('/api/config', patch)
}

// ── Models ───────────────────────────────────────────────────────

export async function listModels(): Promise<{
  object: string
  data: Array<{ id: string; object: string }>
}> {
  return hermesGet('/v1/models')
}

// ── Connection check ─────────────────────────────────────────────

export async function isHermesAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${HERMES_API}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      await probeGateway({ force: true })
      return false
    }
    await probeGateway({ force: true })
    return true
  } catch {
    await probeGateway({ force: true }).catch(() => undefined)
    return false
  }
}

export {
  ensureGatewayCoreProbed,
  ensureGatewayProbed,
  ensureSessionsCapability,
  getCapabilities as getGatewayCapabilities,
  HERMES_API,
  SESSIONS_API_UNAVAILABLE_MESSAGE,
}
