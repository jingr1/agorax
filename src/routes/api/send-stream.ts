import { createFileRoute } from '@tanstack/react-router'
import { assistantMessageIdForRun } from '../../lib/chat-turn-identity'
import { buildResolvedSessionHeaders } from '../../lib/send-stream-session-headers'
import { buildWorkspaceScopedTextMessage } from '../../lib/workspace-message-scope'
import { resolveSessionKey } from '../../server/session-utils'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { publishChatEvent } from '../../server/chat-event-bus'
import {
  registerActiveSendRun,
  unregisterActiveSendRun,
} from '../../server/send-run-tracker'
import {
  appendRunText,
  createPersistedRun,
  markRunStatus,
  setRunThinking,
  upsertRunToolCall,
} from '../../server/run-store'
import {
  clearRunDetached,
  markRunDetached,
} from '../../server/stream-handoff-registry'
import {
  evaluateClientDisconnect,
  shouldAbortUpstreamOnStreamClose,
} from '../../server/stream-client-disconnect'
import { getChatMode } from '../../server/gateway-capabilities'
import {
  ensureChatGateway,
  enterChatGateway,
} from '../../server/chat-gateway'
import {
  appendLocalMessage,
  ensureLocalSession,
  getLocalMessages,
  touchLocalSession,
} from '../../server/local-session-store'
import {
  getDiscoveredModels,
  getLocalProviderDef,
} from '../../server/local-provider-discovery'
import { openaiChat } from '../../server/openai-compat-api'
import { streamResponses } from '../../server/responses-api'
import { selectPortableConversationHistory } from '../../server/portable-history'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  createSession,
  ensureSessionsCapability,
  getGatewayCapabilities,
  getMessages as getSessionMessagesFromAgent,
  listSessions,
  streamChat,
} from '../../server/hermes-api'
import { loadWorkspaceCatalog } from './workspace'
import {
  collectGatewayPayloadToolEvents,
  collectSyntheticLiveToolEvents,
  collectSyntheticLiveThinkingText,
  createSyntheticLiveToolTracker,
} from './-send-stream-live-tools'
import type {
  OpenAICompatContentPart,
  OpenAICompatMessage,
} from '../../server/openai-compat-api'
// Claude agent runs can take 5+ minutes with complex tool chains
const SEND_STREAM_RUN_TIMEOUT_MS = 600_000
const SESSION_BOOTSTRAP_KEYS = new Set(['main', 'new'])

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Thinking tag names the gateway may inline into assistant text. The upstream
 * can emit reasoning either as a dedicated `tool.progress` (_thinking) event or
 * embedded in the assistant delta text. When embedded, we split it out here so
 * the frontend renders it in the Activity/Working panel instead of inside the
 * visible assistant bubble. `think` is the canonical Claude reasoning tag used
 * by Hermes Agent's OpenAI-compat stream.
 */
const THINKING_TAG_NAMES = ['think', 'thinking', 'antThinking', 'thought'] as const

const THINKING_OPEN_TAG =
  '<(?:thinking|antThinking|thought|think)\\b[^>]*(?:>[\\s\\S]*)?'

/**
 * Split a streamed assistant buffer into visible text, closed thinking, and
 * the still-open thinking body.
 *
 * Closed `<think>…</think>` pairs are committed. An unclosed tag — including
 * one whose `>` has not arrived yet — stays in `remainingBuffer` so the next
 * chunk can finish it, and its body is returned as `pendingThinking` so the
 * Working card can render before the close tag.
 */
export function extractStreamingThinking(buffer: string): {
  displayText: string
  extractedThinking: string
  pendingThinking: string
  remainingBuffer: string
} {
  let extractedThinking = ''
  let rest = buffer

  for (const tag of THINKING_TAG_NAMES) {
    const complete = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi')
    rest = rest.replace(complete, (_match, body: string) => {
      if (body) extractedThinking += body
      return ''
    })
  }

  const unclosed = new RegExp(`${THINKING_OPEN_TAG}$`, 'i').exec(rest)
  let pendingThinking = ''
  let displayText = rest
  // Keep already-visible text in the buffer. fullReplace chunks are the whole
  // visible accumulation, not just the latest delta. Only the unclosed tag
  // stays attached so the next frame can finish it.
  let remainingBuffer = rest
  if (unclosed && unclosed.index >= 0) {
    displayText = rest.slice(0, unclosed.index)
    remainingBuffer = displayText + unclosed[0]
    const openEnd = unclosed[0].indexOf('>')
    if (openEnd >= 0) pendingThinking = unclosed[0].slice(openEnd + 1)
  }

  return { displayText, extractedThinking, pendingThinking, remainingBuffer }
}

/** Closed thinking plus the still-open body, without committing the open body. */
export function mergeLiveThinking(closed: string, pending: string): string {
  const closedTrim = closed.trim()
  const pendingTrim = pending.trim()
  if (!pendingTrim) return closedTrim
  if (!closedTrim) return pendingTrim
  if (closedTrim.endsWith(pendingTrim)) return closedTrim
  return `${closedTrim}\n\n${pendingTrim}`
}

/**
 * Fold one assistant text buffer. Closed pairs append to `closedThinking`.
 * The open body stays out of that accumulator so the close tag does not
 * commit it twice.
 */
export function consumeInlineThinking(
  buffer: string,
  closedThinking: string,
): {
  buffer: string
  closedThinking: string
  liveThinking: string
  displayText: string
} {
  const split = extractStreamingThinking(buffer)
  const nextClosed = split.extractedThinking
    ? closedThinking + split.extractedThinking
    : closedThinking
  return {
    buffer: split.remainingBuffer,
    closedThinking: nextClosed,
    liveThinking: mergeLiveThinking(nextClosed, split.pendingThinking),
    displayText: split.displayText,
  }
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.toLowerCase().startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

function normalizeAttachments(
  attachments: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined
  }

  const normalized: Array<Record<string, unknown>> = []
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue
    const source = attachment as Record<string, unknown>

    const id = readString(source.id)
    const name = readString(source.name) || readString(source.fileName)
    const mimeType =
      readString(source.contentType) ||
      readString(source.mimeType) ||
      readString(source.mediaType)
    const size = readNumber(source.size)

    const base64Raw =
      readString(source.content) ||
      readString(source.data) ||
      readString(source.base64) ||
      readString(source.dataUrl)
    const content = stripDataUrlPrefix(base64Raw)
    if (!content) continue

    const type =
      readString(source.type) ||
      (mimeType.toLowerCase().startsWith('image/') ? 'image' : 'file')

    const dataUrl =
      readString(source.dataUrl) ||
      (mimeType ? `data:${mimeType};base64,${content}` : '')

    normalized.push({
      id: id || undefined,
      name: name || undefined,
      fileName: name || undefined,
      type,
      contentType: mimeType || undefined,
      mimeType: mimeType || undefined,
      mediaType: mimeType || undefined,
      content,
      data: content,
      base64: content,
      dataUrl: dataUrl || undefined,
      size,
    })
  }

  return normalized.length > 0 ? normalized : undefined
}

function getChatMessage(
  message: string,
  attachments?: Array<Record<string, unknown>>,
): string {
  if (message.trim().length > 0) return message
  if (attachments && attachments.length > 0) {
    return 'Please review the attached content.'
  }
  return message
}

/**
 * Build OpenAI-compatible multimodal content for portable mode.
 * If there are image attachments, returns an array of content parts;
 * otherwise returns a plain string.
 */
function buildMultimodalContent(
  message: string,
  attachments?: Array<Record<string, unknown>>,
): string | Array<OpenAICompatContentPart> {
  const imageParts: Array<OpenAICompatContentPart> = []

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      const mime = (att.contentType ||
        att.mimeType ||
        att.mediaType ||
        '') as string
      if (!mime.toLowerCase().startsWith('image/')) continue

      let b64 = (att.base64 || att.content || att.data || '') as string
      if (!b64) {
        const dataUrl = (att.dataUrl || '') as string
        if (dataUrl.startsWith('data:') && dataUrl.includes(',')) {
          b64 = dataUrl.split(',')[1]
        }
      }
      if (!b64) continue

      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      })
    }
  }

  if (imageParts.length === 0) {
    return getChatMessage(message, attachments)
  }

  const parts: Array<OpenAICompatContentPart> = []
  const text = message.trim() || 'Please review the attached content.'
  parts.push({ type: 'text', text })
  parts.push(...imageParts)
  return parts
}

type PortableHistoryMessage = {
  role: string
  content: string
}

function normalizePortableHistory(
  value: unknown,
): Array<PortableHistoryMessage> {
  if (!Array.isArray(value) || value.length === 0) return []

  const normalized: Array<PortableHistoryMessage> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const role = readString(record.role)
    const content = readString(record.content)
    if (!role || !content) continue
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    normalized.push({ role, content })
  }

  return normalized
}

function normalizeClaudeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.trim()
  if (!message) return 'Claude request failed'
  return message.replace(/\bserver\b/gi, 'Claude')
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function getToolName(data: Record<string, unknown>): string {
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

/**
 * Extract a reasoning delta from a `tool.progress` payload, or null when the
 * payload is not a reasoning event. Hermes Agent surfaces reasoning through
 * event_type 'reasoning.available' (text in `preview`) and '_thinking' (text
 * in `name`), plus the legacy `_thinking`/`tool` tool-name form.
 */
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

/**
 * Extract reasoning text from a top-level Hermes SSE event
 * (`reasoning.delta`, `reasoning.available`, Responses-style
 * `response.reasoning_text.delta`). Newer gateways stream these instead of
 * synthetic `_thinking` tool.progress — without this, Activity shows tools
 * only.
 */
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

function getToolCallId(
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

function getToolArgs(data: Record<string, unknown>): unknown {
  const toolCall = readRecord(data.tool_call)
  const toolFunction = readRecord(toolCall?.function)
  return parseJsonIfPossible(
    toolCall?.arguments ?? toolFunction?.arguments ?? data.args,
  )
}

function getToolResultPreview(data: Record<string, unknown>): string {
  const raw = data.result_preview ?? data.result ?? data.output ?? data.message
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return ''
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return String(raw)
  }
}

export const Route = createFileRoute('/api/send-stream')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Auth check
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        // Read body before choosing a gateway. Pool-on chat pins this
        // request to the profile's own port and does not move HERMES_API.
        let body: Record<string, unknown> = {}
        try {
          const rawBody = await request.text()
          body = JSON.parse(rawBody) as Record<string, unknown>
        } catch {
          // Fall through — body stays empty, will hit 'message required' below
        }

        const requestedProfile =
          typeof body.profileName === 'string' ? body.profileName.trim() : ''
        try {
          enterChatGateway(await ensureChatGateway(requestedProfile))
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : 'gateway unavailable'
          return new Response(JSON.stringify({ ok: false, error: errorMsg }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        await ensureSessionsCapability()

        const rawSessionKey =
          typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
        const requestedFriendlyId =
          typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
        const message = String(body.message ?? '')
        const thinking =
          typeof body.thinking === 'string' ? body.thinking : undefined
        const attachments = normalizeAttachments(body.attachments)
        const history = normalizePortableHistory(body.history)
        if (!message.trim() && (!attachments || attachments.length === 0)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'message required' }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        // Resolve session key
        let sessionKey: string
        let resolvedFriendlyId: string
        try {
          const resolved = await resolveSessionKey({
            rawSessionKey,
            friendlyId: requestedFriendlyId,
            defaultKey: 'main',
          })
          sessionKey = resolved.sessionKey
          resolvedFriendlyId = resolved.sessionKey
        } catch (err) {
          const errorMsg = normalizeClaudeErrorMessage(err)
          if (errorMsg === 'session not found') {
            return new Response(
              JSON.stringify({ ok: false, error: 'session not found' }),
              {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              },
            )
          }
          return new Response(JSON.stringify({ ok: false, error: errorMsg }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // Check if the selected model is a local provider model — force portable + direct routing
        let chatMode = getChatMode()
        let localBaseUrl: string | undefined
        const requestModel = typeof body.model === 'string' ? body.model : ''
        const bareModel = requestModel.includes('/')
          ? requestModel.split('/').slice(1).join('/')
          : requestModel
        if (requestModel) {
          const discoveredModels = getDiscoveredModels()
          const localMatch = discoveredModels.find(
            (m) => m.id === requestModel || m.id === bareModel,
          )
          if (localMatch) {
            const providerDef = getLocalProviderDef(localMatch.provider)
            if (providerDef) {
              chatMode = 'portable'
              localBaseUrl = providerDef.baseUrl
            }
          }
        }
        if (chatMode === 'portable' && sessionKey === 'new') {
          sessionKey = crypto.randomUUID()
          resolvedFriendlyId = sessionKey
        }

        const workspaceScope = await loadWorkspaceCatalog().catch(() => null)
        const scopedMessage = buildWorkspaceScopedTextMessage(
          getChatMessage(message, attachments),
          workspaceScope,
        )

        // Create streaming response using the SHARED server connection
        const encoder = new TextEncoder()
        let streamClosed = false
        let activeRunId: string | null = null
        let activeRunSessionKey: string | null = null
        let persistedRunReady: Promise<unknown> | null = null
        let unregisterTimer: ReturnType<typeof setTimeout> | null = null
        let streamTimeoutTimer: ReturnType<typeof setTimeout> | null = null
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null
        const abortController = new AbortController()
        let keepUpstreamAlive = false
        let detachedHandoff = false
        let userStopped = false
        const liveRunIds = new Set<string>()
        // Bind a run id to this request's AbortController so POST /api/runs/:id/stop
        // can hard-interrupt Hermes even after the browser lost its fetch handle.
        const bindLiveSendRun = (runId: string, runSessionKey: string) => {
          const trimmed = runId.trim()
          if (!trimmed) return
          liveRunIds.add(trimmed)
          registerActiveSendRun(trimmed, {
            sessionKey: runSessionKey,
            abortUpstream: () => {
              userStopped = true
              clearRunDetached(trimmed)
              keepUpstreamAlive = false
              detachedHandoff = false
              if (!abortController.signal.aborted) {
                abortController.abort()
              }
            },
          })
        }
        const unbindLiveSendRuns = () => {
          for (const id of liveRunIds) {
            unregisterActiveSendRun(id)
          }
          liveRunIds.clear()
        }
        // Close the browser SSE leg. When keepUpstreamAlive is true (profile
        // handoff), the upstream Hermes gateway request continues in this
        // handler until run.completed / error.
        let closeStream = (options?: { abortUpstream?: boolean }) => {
          if (streamClosed) return
          streamClosed = true
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          if (unregisterTimer) {
            clearTimeout(unregisterTimer)
            unregisterTimer = null
          }
          if (streamTimeoutTimer) {
            clearTimeout(streamTimeoutTimer)
            streamTimeoutTimer = null
          }
          if (
            shouldAbortUpstreamOnStreamClose({
              explicitAbort: options?.abortUpstream,
              keepUpstreamAlive,
              detachedHandoff,
            })
          ) {
            abortController.abort()
          }
          if (!keepUpstreamAlive && !detachedHandoff) {
            unbindLiveSendRuns()
          }
        }

        function handleClientDisconnect() {
          if (activeRunId && !userStopped) {
            markRunDetached(activeRunId)
          }
          const evaluation = evaluateClientDisconnect({
            activeRunId,
            streamClosed,
            userStopped,
          })
          keepUpstreamAlive = evaluation.keepUpstreamAlive
          detachedHandoff = evaluation.detachedHandoff
          if (evaluation.shouldPersistHandoff) {
            persistActiveRun((runSessionKey, activeId) =>
              markRunStatus(runSessionKey, activeId, 'handoff'),
            )
          } else if (evaluation.runIdToUnregister) {
            // Handoff keeps handles alive for a later explicit Stop; abort path
            // drops them in closeStream via unbindLiveSendRuns.
            liveRunIds.delete(evaluation.runIdToUnregister)
            unregisterActiveSendRun(evaluation.runIdToUnregister)
            activeRunId = null
          }
          closeStream()
        }

        // When the client hits Stop / navigates away / closes the tab, the
        // request.signal fires abort. Detached profile handoffs keep upstream
        // alive; explicit stops abort the agent.
        request.signal.addEventListener(
          'abort',
          () => handleClientDisconnect(),
          {
            once: true,
          },
        )

        const persistRunStarted = (
          runId: string | undefined,
          runSessionKey: string,
          friendlyId: string,
        ) => {
          if (!runId || persistedRunReady) return
          activeRunSessionKey = runSessionKey
          persistedRunReady = createPersistedRun({
            runId,
            sessionKey: runSessionKey,
            friendlyId,
          }).catch(() => null)
        }

        const persistActiveRun = (
          write: (sessionKey: string, runId: string) => Promise<unknown>,
        ) => {
          if (!activeRunId || !activeRunSessionKey) return
          const runId = activeRunId
          const runSessionKey = activeRunSessionKey
          void (persistedRunReady ?? Promise.resolve())
            .then(() => write(runSessionKey, runId))
            .catch(() => null)
        }

        const stream = new ReadableStream({
          async start(controller) {
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null
            let lastClientEventAt = Date.now()
            // Track the last human-readable activity so the heartbeat can
            // forward it to the UI. Without this TurnActivityHost shows a
            // static empty Working card for minutes when the agent is
            // reasoning without tool calls, making it look hung.
            let lastActivity: string | null = null
            const enqueueRaw = (payload: string) => {
              if (streamClosed) return
              controller.enqueue(encoder.encode(payload))
            }
            const sendEvent = (event: string, data: unknown) => {
              if (streamClosed) return
              lastClientEventAt = Date.now()
              const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
              enqueueRaw(payload)
            }

            // Cloudflare Tunnel/Access can otherwise leave small SSE streams idle
            // long enough that the browser-side fetch is canceled before visible
            // assistant chunks arrive. Send an initial padding comment and a
            // lightweight recognized event periodically so public Workspace chats
            // do not sit at "Thinking…" until the frontend reports failure.
            enqueueRaw(`: ${' '.repeat(2048)}\n\n`)
            heartbeatTimer = setInterval(() => {
              if (streamClosed) return
              if (Date.now() - lastClientEventAt < 10_000) return
              // Heartbeat to keep Cloudflare/Access from culling the SSE stream.
              // Use a dedicated hb_signal event (not 'thinking') so it does not
              // pollute the TUI activity card with fake thinking text. Send a
              // tiny SSE comment as the actual keepalive byte.
              sendEvent('hb_signal', { sessionKey })
              enqueueRaw(': keepalive\n\n')
            }, 10_000)

            closeStream = (options?: { abortUpstream?: boolean }) => {
              if (streamClosed) return
              streamClosed = true
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              if (unregisterTimer) {
                clearTimeout(unregisterTimer)
                unregisterTimer = null
              }
              if (streamTimeoutTimer) {
                clearTimeout(streamTimeoutTimer)
                streamTimeoutTimer = null
              }
              if (
                shouldAbortUpstreamOnStreamClose({
                  explicitAbort: options?.abortUpstream,
                  keepUpstreamAlive,
                  detachedHandoff,
                })
              ) {
                abortController.abort()
              }
              if (!keepUpstreamAlive && !detachedHandoff) {
                unbindLiveSendRuns()
                activeRunId = null
              }
              try {
                controller.close()
              } catch {
                // ignore
              }
            }

            // Keep the SSE stream alive during long agent processing (tool calls,
            // slow LLM responses on large contexts). Without this the client-side
            // no-activity timer fires after 2-3 min and aborts the stream.
            // Every 10s we also forward the last known activity so the UI can
            // show meaningful progress instead of a static "Thinking…".
            heartbeatTimer = setInterval(() => {
              sendEvent('heartbeat', {
                timestamp: Date.now(),
                activity: lastActivity,
              })
            }, 10_000)

            try {
              if (chatMode === 'portable') {
                const runId = crypto.randomUUID()
                const portableSessionKey = sessionKey

                // Ensure session exists (user message appended after building history)
                ensureLocalSession(
                  portableSessionKey,
                  typeof body.model === 'string' ? body.model : undefined,
                )
                const portableFriendlyId =
                  resolvedFriendlyId ||
                  requestedFriendlyId ||
                  rawSessionKey ||
                  portableSessionKey
                let accumulated = ''

                activeRunId = runId
                bindLiveSendRun(runId, portableSessionKey)
                persistRunStarted(runId, portableSessionKey, portableFriendlyId)

                sendEvent('started', {
                  runId,
                  messageId: assistantMessageIdForRun(runId, portableSessionKey),
                  sessionKey: portableSessionKey,
                  friendlyId: portableFriendlyId,
                })
                lastActivity = 'Processing your message...'

                try {
                  const userContent = buildMultimodalContent(
                    scopedMessage,
                    attachments,
                  )
                  // Inject locale preference so the agent responds in the user's language
                  const locale =
                    typeof body.locale === 'string' ? body.locale.trim() : ''
                  const localeSystemMsg: Array<OpenAICompatMessage> =
                    locale === 'zh'
                      ? [
                          {
                            role: 'system',
                            content:
                              "Respond in Chinese. The user's interface is set to this language.",
                          },
                        ]
                      : []
                  // Load persisted history for this session, then append user message.
                  // When the gateway can bind portable chat to a server-side session
                  // via X-Hermes-Session-Id, replaying the entire local transcript on
                  // every turn duplicates prompt context and can trip model limits
                  // on otherwise simple tasks (#405).
                  const persistedMessages = getLocalMessages(portableSessionKey)
                  const persistedHistory = persistedMessages.map((m) => ({
                    role: m.role as 'user' | 'assistant' | 'system',
                    content: m.content,
                  }))
                  // Persist user message AFTER reading history to avoid duplication
                  appendLocalMessage(portableSessionKey, {
                    id: crypto.randomUUID(),
                    role: 'user',
                    content:
                      typeof body.message === 'string' ? body.message : '',
                    timestamp: Date.now(),
                  })
                  const effectiveHistory = selectPortableConversationHistory(
                    persistedHistory,
                    history,
                    { localBaseUrl },
                  )
                  const portableMessages: Array<OpenAICompatMessage> = [
                    ...localeSystemMsg,
                    ...effectiveHistory,
                    {
                      role: 'user',
                      content: userContent,
                    },
                  ]
                  // Vanilla Hermes Agent (>=v0.12.x) ships a structured
                  // Responses-API streaming surface at POST /v1/responses
                  // that carries full tool args + results, unlike the
                  // /v1/chat/completions surface which only emits a thin
                  // hermes.tool.progress lifecycle event. When the user
                  // opts into the Responses path AND we're talking to the
                  // local Hermes gateway (no localBaseUrl override), use
                  // it so the TUI tool card can render INPUT JSON and
                  // tool output text live during the run. Falls back
                  // automatically on any error to the existing
                  // openaiChat path.
                  const useResponsesApi =
                    process.env.HERMES_USE_RESPONSES === '1' && !localBaseUrl
                  if (useResponsesApi) {
                    const thinking = ''
                    // Track tool calls by callId so a `tool.completed`
                    // followed by `tool.output` can carry the full
                    // arguments forward without losing them.
                    const toolStateByCallId = new Map<
                      string,
                      {
                        name: string
                        args: Record<string, unknown> | string | null
                      }
                    >()
                    try {
                      const responsesStream = streamResponses({
                        input: scopedMessage,
                        conversationHistory: effectiveHistory,
                        model:
                          typeof body.model === 'string'
                            ? body.model
                            : undefined,
                        sessionId: portableSessionKey,
                        signal: abortController.signal,
                        profileName:
                          typeof body.profileName === 'string'
                            ? body.profileName
                            : undefined,
                      })
                      for await (const ev of responsesStream) {
                        if (ev.kind === 'text.delta') {
                          accumulated += ev.delta
                          persistActiveRun((runSessionKey, activeId) =>
                            appendRunText(
                              runSessionKey,
                              activeId,
                              accumulated,
                              { replace: true },
                            ),
                          )
                          sendEvent('chunk', {
                            text: accumulated,
                            fullReplace: true,
                            sessionKey: portableSessionKey,
                            runId,
                          })
                          continue
                        }
                        if (ev.kind === 'tool.started') {
                          toolStateByCallId.set(ev.callId, {
                            name: ev.name,
                            args: ev.args,
                          })
                          const argsForCard =
                            ev.args && typeof ev.args === 'object'
                              ? ev.args
                              : undefined
                          persistActiveRun((runSessionKey, activeId) =>
                            upsertRunToolCall(runSessionKey, activeId, {
                              id: ev.callId,
                              name: ev.name,
                              phase: 'calling',
                              args: argsForCard,
                            }),
                          )
                          sendEvent('tool', {
                            phase: 'calling',
                            name: ev.name,
                            toolCallId: ev.callId,
                            args: argsForCard,
                            sessionKey: portableSessionKey,
                            runId,
                          })
                          lastActivity = `Running: ${ev.name.replace(/_/g, ' ')}`
                          continue
                        }
                        if (ev.kind === 'tool.completed') {
                          // Mark as complete but keep the args+result we
                          // accumulated so the card stays expandable.
                          // Vanilla emits tool.completed BEFORE the
                          // matching function_call_output, so we
                          // intentionally do not flip phase to 'complete'
                          // until the output arrives. Otherwise the card
                          // briefly flashes "done" with no result text.
                          continue
                        }
                        if (ev.kind === 'tool.output') {
                          const state = toolStateByCallId.get(ev.callId)
                          const argsForCard =
                            state?.args && typeof state.args === 'object'
                              ? state.args
                              : undefined
                          const name = state?.name || 'tool'
                          persistActiveRun((runSessionKey, activeId) =>
                            upsertRunToolCall(runSessionKey, activeId, {
                              id: ev.callId,
                              name,
                              phase: 'complete',
                              args: argsForCard,
                              result: ev.output,
                            }),
                          )
                          sendEvent('tool', {
                            phase: 'complete',
                            name,
                            toolCallId: ev.callId,
                            args: argsForCard,
                            result: ev.output,
                            sessionKey: portableSessionKey,
                            runId,
                          })
                          lastActivity = `Completed: ${name.replace(/_/g, ' ')}`
                          continue
                        }
                        if (ev.kind === 'completed') {
                          // Final terminal event — fall through to the
                          // shared 'done' emit below.
                          break
                        }
                        if (ev.kind === 'failed') {
                          throw new Error(ev.error)
                        }
                      }
                      appendLocalMessage(portableSessionKey, {
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: accumulated,
                        timestamp: Date.now(),
                      })
                      touchLocalSession(portableSessionKey)
                      persistActiveRun((runSessionKey, activeId) =>
                        markRunStatus(runSessionKey, activeId, 'complete'),
                      )
                      clearRunDetached(runId)
                      sendEvent('done', {
                        state: 'complete',
                        sessionKey: portableSessionKey,
                        runId,
                        message: {
                          role: 'assistant',
                          content: [
                            ...(thinking
                              ? [{ type: 'thinking', thinking }]
                              : []),
                            { type: 'text', text: accumulated },
                          ],
                        },
                      })
                      closeStream()
                      return
                    } catch (err) {
                      // Log and fall through to the openaiChat path so a
                      // misconfigured /v1/responses surface (older agent,
                      // CORS issue, network blip) doesn't break the chat.
                      console.warn(
                        '[send-stream] /v1/responses path failed, falling back to /v1/chat/completions:',
                        err,
                      )
                      // Reset accumulated so the fallback starts clean.
                      accumulated = ''
                    }
                  }

                  const stream = await openaiChat(portableMessages, {
                    model: localBaseUrl
                      ? bareModel
                      : typeof body.model === 'string'
                        ? body.model
                        : undefined,
                    temperature:
                      typeof body.temperature === 'number'
                        ? body.temperature
                        : undefined,
                    signal: abortController.signal,
                    stream: true,
                    sessionId: portableSessionKey,
                    baseUrl: localBaseUrl,
                    profileName:
                      typeof body.profileName === 'string'
                        ? body.profileName
                        : undefined,
                  })

                  let thinking = ''
                  let toolEventCount = 0
                  for await (const chunk of stream) {
                    if (
                      chunk.type === 'approval' ||
                      chunk.type === 'approval.responded'
                    ) {
                      const approvalRunId =
                        typeof chunk.data.run_id === 'string' &&
                        chunk.data.run_id.trim()
                          ? chunk.data.run_id.trim()
                          : typeof chunk.data.runId === 'string' &&
                              chunk.data.runId.trim()
                            ? chunk.data.runId.trim()
                            : runId
                      if (approvalRunId) {
                        bindLiveSendRun(approvalRunId, portableSessionKey)
                        activeRunId = approvalRunId
                      }
                      sendEvent(chunk.type, {
                        ...chunk.data,
                        event:
                          chunk.type === 'approval'
                            ? 'approval.request'
                            : 'approval.responded',
                        runId: approvalRunId,
                        run_id: approvalRunId,
                        sessionKey: portableSessionKey,
                      })
                      if (chunk.type === 'approval') {
                        lastActivity = 'Waiting for approval...'
                      }
                      continue
                    }
                    if (chunk.type === 'reasoning') {
                      thinking += chunk.text
                      persistActiveRun((runSessionKey, activeId) =>
                        setRunThinking(runSessionKey, activeId, thinking),
                      )
                      sendEvent('thinking', {
                        text: thinking,
                        sessionKey: portableSessionKey,
                        runId,
                      })
                    } else if (chunk.type === 'tool') {
                      // Prefer the gateway's stable tool_call_id so 'running'
                      // and 'completed' events for the same call collapse to
                      // one card row. Fall back to a synthetic id only when
                      // the upstream payload lacks one (older Hermes builds).
                      toolEventCount += 1
                      const toolCallId =
                        chunk.toolCallId ||
                        `${runId}:${chunk.name}:${toolEventCount}`
                      // Map upstream status -> internal phase. 'running'
                      // arrives at tool start; 'completed' at finish.
                      // Missing status (back-compat path) is treated as a
                      // one-shot 'calling' to mirror the previous behavior.
                      const phase =
                        chunk.status === 'completed'
                          ? 'complete'
                          : chunk.status === 'running'
                            ? 'calling'
                            : 'start'
                      persistActiveRun((runSessionKey, activeId) =>
                        upsertRunToolCall(runSessionKey, activeId, {
                          id: toolCallId,
                          name: chunk.name || 'tool',
                          phase,
                          preview: chunk.label,
                        }),
                      )
                      sendEvent('tool', {
                        phase,
                        name: chunk.name,
                        toolCallId,
                        preview: chunk.label,
                        sessionKey: portableSessionKey,
                        runId,
                      })
                    } else {
                      accumulated += chunk.text
                      persistActiveRun((runSessionKey, activeId) =>
                        appendRunText(runSessionKey, activeId, accumulated, {
                          replace: true,
                        }),
                      )
                      sendEvent('chunk', {
                        text: accumulated,
                        fullReplace: true,
                        sessionKey: portableSessionKey,
                        runId,
                      })
                    }
                  }

                  // Persist assistant response to local session store
                  appendLocalMessage(portableSessionKey, {
                    id: crypto.randomUUID(),
                    role: 'assistant',
                    content: accumulated,
                    timestamp: Date.now(),
                  })
                  touchLocalSession(portableSessionKey)

                  persistActiveRun((runSessionKey, activeId) =>
                    markRunStatus(runSessionKey, activeId, 'complete'),
                  )
                  clearRunDetached(runId)
                  sendEvent('done', {
                    state: 'complete',
                    sessionKey: portableSessionKey,
                    runId,
                    message: {
                      role: 'assistant',
                      content: [
                        ...(thinking ? [{ type: 'thinking', thinking }] : []),
                        { type: 'text', text: accumulated },
                      ],
                    },
                  })
                  closeStream()
                } catch (err) {
                  if (!streamClosed) {
                    const errorMessage = normalizeClaudeErrorMessage(err)
                    persistActiveRun((runSessionKey, activeId) =>
                      markRunStatus(
                        runSessionKey,
                        activeId,
                        'error',
                        errorMessage,
                      ),
                    )
                    sendEvent('error', {
                      message: errorMessage,
                      sessionKey: portableSessionKey,
                      runId,
                    })
                    closeStream()
                  }
                }
                return
              }

              if (!getGatewayCapabilities().sessions) {
                throw new Error(SESSIONS_API_UNAVAILABLE_MESSAGE)
              }

              if (SESSION_BOOTSTRAP_KEYS.has(sessionKey)) {
                // 'main' should land in the user's existing main chat,
                // not spin up a brand new session every time. Skip cron
                // and Operations per-agent sessions so the orchestrator
                // chat doesn't latch onto them.
                let reused: string | null = null
                if (sessionKey === 'main') {
                  try {
                    const recent = await listSessions(30, 0)
                    const isInternal = (id: string) =>
                      id.startsWith('cron_') ||
                      id.startsWith('cron:') ||
                      id.startsWith('agent:main:ops-')
                    const hasRealTitle = (s: {
                      id: string
                      title?: string | null
                    }) => {
                      const t = (s.title ?? '').trim()
                      return t.length > 0 && t !== s.id
                    }
                    const titled = recent.find(
                      (s) => !isInternal(s.id) && hasRealTitle(s),
                    )
                    const fallback = titled
                      ? null
                      : recent.find(
                          (s) =>
                            !isInternal(s.id) &&
                            typeof s.message_count === 'number' &&
                            s.message_count > 0,
                        )
                    const candidate = titled ?? fallback
                    if (candidate) reused = candidate.id
                  } catch {
                    // fall through to createSession()
                  }
                }
                if (reused) {
                  sessionKey = reused
                  resolvedFriendlyId = reused
                } else {
                  const session = await createSession()
                  sessionKey = session.id
                  resolvedFriendlyId = session.id
                }
              }

              let startedSent = false
              let thinkingAccumulated = ''
              let lastPublishedInlineThinking = ''
              // Buffers raw assistant deltas so we can split out <thinking>
              // blocks that the gateway inlines into the text stream.
              let assistantTextBuffer = ''
              // In enhanced mode, the HTTP stream response delivers all events
              // directly to useStreamingMessage. Skip publishChatEvent to prevent
              // useRealtimeChatHistory from creating duplicate message bubbles.
              const skipPublish = true

              // Bind a Workspace run id immediately so Stop works before the
              // gateway emits its own run_id (and after the browser remounts).
              const workspaceRunId = crypto.randomUUID()
              activeRunId = workspaceRunId
              bindLiveSendRun(workspaceRunId, sessionKey)
              persistRunStarted(
                workspaceRunId,
                sessionKey,
                resolvedFriendlyId || sessionKey,
              )
              startedSent = true
              sendEvent('started', {
                runId: workspaceRunId,
                messageId: assistantMessageIdForRun(workspaceRunId, sessionKey),
                sessionKey,
                friendlyId: resolvedFriendlyId || sessionKey,
              })
              lastActivity = 'Processing your message...'

              // Mid-run tool polling: vanilla Hermes Agent often does not emit
              // tool.* SSE live. Poll the session for tool_calls that were not
              // already on an event payload. `calling` goes out as soon as the
              // call is persisted; the tracker dedupes against live events.
              const syntheticLiveToolTracker = createSyntheticLiveToolTracker()
              let lastSyntheticThinkingEmitted = ''
              let liveRunActive = true
              const livePollIntervalMs = 800
              // Snapshot the session message count at run-start so the poller
              // and the post-run backfill only consider messages persisted by
              // THIS run. Without this, "the most recent assistant with
              // tool_calls" can resolve to the previous turn, surfacing stale
              // tool cards (off-by-one-turn bug).
              let liveBaselineCount = 0
              try {
                const baseline = (await getSessionMessagesFromAgent(
                  sessionKey,
                )) as unknown as Array<Record<string, unknown>>
                if (Array.isArray(baseline)) liveBaselineCount = baseline.length
              } catch {
                liveBaselineCount = 0
              }
              const publishInlineThinking = (
                sessionKeyFromEvent: string,
                runId: string | undefined,
              ): string => {
                const next = consumeInlineThinking(
                  assistantTextBuffer,
                  thinkingAccumulated,
                )
                assistantTextBuffer = next.buffer
                thinkingAccumulated = next.closedThinking
                if (
                  next.liveThinking &&
                  next.liveThinking !== lastPublishedInlineThinking
                ) {
                  lastPublishedInlineThinking = next.liveThinking
                  persistActiveRun((runSessionKey, activeId) =>
                    setRunThinking(
                      runSessionKey,
                      activeId,
                      next.liveThinking,
                    ),
                  )
                  const translated = {
                    text: next.liveThinking,
                    sessionKey: sessionKeyFromEvent,
                    runId,
                  }
                  sendEvent('thinking', translated)
                  skipPublish || publishChatEvent('thinking', translated)
                }
                return next.displayText
              }

              const livePollerPromise = (async () => {
                while (liveRunActive) {
                  if (!liveRunActive || streamClosed) break
                  try {
                    const allMsgs = (await getSessionMessagesFromAgent(
                      sessionKey,
                    )) as unknown as Array<Record<string, unknown>>
                    if (!Array.isArray(allMsgs) || allMsgs.length === 0) {
                      await new Promise((r) =>
                        setTimeout(r, livePollIntervalMs),
                      )
                      continue
                    }
                    // Only inspect messages added on or after this run started.
                    const msgs = allMsgs.slice(liveBaselineCount)
                    if (msgs.length === 0) {
                      await new Promise((r) =>
                        setTimeout(r, livePollIntervalMs),
                      )
                      continue
                    }
                    const syntheticThinking =
                      collectSyntheticLiveThinkingText(msgs)
                    if (
                      syntheticThinking.length >
                      lastSyntheticThinkingEmitted.length
                    ) {
                      lastSyntheticThinkingEmitted = syntheticThinking
                      persistActiveRun((runSessionKey, activeId) =>
                        setRunThinking(
                          runSessionKey,
                          activeId,
                          syntheticThinking,
                        ),
                      )
                      sendEvent('thinking', {
                        text: syntheticThinking,
                        sessionKey,
                        runId: activeRunId ?? undefined,
                      })
                    }

                    const syntheticEvents = collectSyntheticLiveToolEvents({
                      messages: msgs,
                      tracker: syntheticLiveToolTracker,
                      sessionKey,
                      runId: activeRunId ?? undefined,
                    })
                    for (const synthetic of syntheticEvents) {
                      sendEvent('tool', synthetic)
                    }
                  } catch {
                    // Best-effort polling; ignore transient errors.
                  }
                  await new Promise((r) => setTimeout(r, livePollIntervalMs))
                }
              })()

              try {
                await streamChat(
                  sessionKey,
                  {
                    message: scopedMessage,
                    model:
                      typeof body.model === 'string' ? body.model : undefined,
                    system_message: thinking,
                    attachments: attachments || undefined,
                  },
                  {
                    signal: abortController.signal,
                    async onEvent({ event, data }) {
                      const sessionKeyFromEvent =
                        typeof data.session_id === 'string' &&
                        data.session_id.trim()
                          ? data.session_id
                          : sessionKey
                      const runId =
                        typeof data.run_id === 'string' && data.run_id.trim()
                          ? data.run_id
                          : typeof data.runId === 'string' && data.runId.trim()
                            ? data.runId
                            : (activeRunId ?? undefined)

                      if (runId) {
                        // Alias gateway run ids to the same AbortController so
                        // either Workspace or Hermes run id can Stop the turn.
                        bindLiveSendRun(runId, sessionKeyFromEvent)
                        if (!activeRunId) activeRunId = runId
                      }

                      // Dangerous-command / MCP trust-gate approvals (hermes-webui
                      // parity). Forward as a first-class SSE event so the Hermes
                      // activity adapter can project an Interaction card.
                      {
                        const payloadEvent = String(
                          data.event || data.type || event || '',
                        )
                          .trim()
                          .toLowerCase()
                        if (
                          payloadEvent === 'approval.request' ||
                          payloadEvent === 'hermes.approval.request'
                        ) {
                          sendEvent('approval', {
                            ...data,
                            event: 'approval.request',
                            runId,
                            run_id: runId,
                            sessionKey: sessionKeyFromEvent,
                          })
                          lastActivity = 'Waiting for approval...'
                          return
                        }
                        if (
                          payloadEvent === 'approval.responded' ||
                          payloadEvent === 'hermes.approval.responded'
                        ) {
                          sendEvent('approval.responded', {
                            ...data,
                            event: 'approval.responded',
                            runId,
                            run_id: runId,
                            sessionKey: sessionKeyFromEvent,
                          })
                          return
                        }
                      }

                      // Tool calls already on this frame. Don't wait for the
                      // session poll — that left Working empty after Thinking
                      // had already cleared.
                      if (!event.startsWith('tool.')) {
                        const payloadTools = collectGatewayPayloadToolEvents({
                          data,
                          tracker: syntheticLiveToolTracker,
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        })
                        for (const synthetic of payloadTools) {
                          persistActiveRun((runSessionKey, activeId) =>
                            upsertRunToolCall(runSessionKey, activeId, {
                              id: synthetic.toolCallId,
                              name: synthetic.name,
                              phase: synthetic.phase,
                              args: synthetic.args,
                              result: synthetic.result,
                            }),
                          )
                          sendEvent('tool', synthetic)
                          skipPublish || publishChatEvent('tool', synthetic)
                          lastActivity = `Running: ${synthetic.name.replace(/_/g, ' ')}`
                        }
                      }

                      if (!startedSent && runId) {
                        startedSent = true
                        sendEvent('started', {
                          runId,
                          messageId: assistantMessageIdForRun(
                            runId,
                            sessionKeyFromEvent,
                          ),
                          sessionKey: sessionKeyFromEvent,
                          friendlyId: sessionKeyFromEvent,
                        })
                        lastActivity = 'Processing your message...'
                      }

                      if (event === 'run.started') {
                        const userMessage =
                          data.user_message &&
                          typeof data.user_message === 'object'
                            ? (data.user_message as Record<string, unknown>)
                            : null
                        if (userMessage) {
                          skipPublish ||
                            publishChatEvent('user_message', {
                              message: {
                                id: userMessage.id,
                                role: userMessage.role ?? 'user',
                                content: [
                                  {
                                    type: 'text',
                                    text:
                                      typeof userMessage.content === 'string'
                                        ? userMessage.content
                                        : '',
                                  },
                                ],
                              },
                              sessionKey: sessionKeyFromEvent,
                              source: 'claude',
                              runId,
                            })
                        }
                        return
                      }

                      if (event === 'message.started') {
                        const message =
                          data.message && typeof data.message === 'object'
                            ? (data.message as Record<string, unknown>)
                            : {}
                        const translated = {
                          message: {
                            id: message.id,
                            role: 'assistant',
                            content: [],
                          },
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        sendEvent('message', translated)
                        skipPublish || publishChatEvent('message', translated)
                        return
                      }

                      if (event === 'assistant.completed') {
                        // Send full content as a chunk — covers cases where
                        // deltas were missed or response was too short for streaming.
                        // Split out any inline thinking blocks so they land in
                        // the Activity panel, not the visible bubble.
                        const content =
                          typeof data.content === 'string' ? data.content : ''
                        if (content) {
                          assistantTextBuffer += content
                          const displayText = publishInlineThinking(
                            sessionKeyFromEvent,
                            runId,
                          )
                          if (displayText.trim()) {
                            persistActiveRun((runSessionKey, activeId) =>
                              appendRunText(runSessionKey, activeId, displayText, {
                                replace: true,
                              }),
                            )
                            const translated = {
                              text: displayText,
                              fullReplace: true,
                              sessionKey: sessionKeyFromEvent,
                              runId,
                            }
                            sendEvent('chunk', translated)
                            skipPublish ||
                              publishChatEvent('chunk', translated)
                          }
                        }
                        return
                      }

                      // Top-level reasoning SSE (newer Hermes gateways). Must
                      // run before tool handlers so Activity gets thinking, not
                      // a fake tool row.
                      {
                        const reasonDelta = extractReasoningFromGatewayEvent(
                          event,
                          data,
                        )
                        if (reasonDelta) {
                          thinkingAccumulated += reasonDelta
                          persistActiveRun((runSessionKey, activeId) =>
                            setRunThinking(
                              runSessionKey,
                              activeId,
                              thinkingAccumulated,
                            ),
                          )
                          const translated = {
                            text: thinkingAccumulated,
                            sessionKey: sessionKeyFromEvent,
                            runId,
                          }
                          sendEvent('thinking', translated)
                          skipPublish ||
                            publishChatEvent('thinking', translated)
                          lastActivity =
                            thinkingAccumulated.length > 60
                              ? thinkingAccumulated.slice(0, 60) + '...'
                              : thinkingAccumulated
                          return
                        }
                      }

                      if (event === 'assistant.delta') {
                        const delta =
                          typeof data.delta === 'string' ? data.delta : ''
                        // Reasoning-capable models (Kimi, DeepSeek, …) send
                        // reasoning deltas in a separate field; surface them as
                        // thinking events so they land in the Activity panel.
                        const reasoningDelta =
                          (typeof data.reasoning_content === 'string'
                            ? data.reasoning_content
                            : '') ||
                          (typeof data.reasoning === 'string'
                            ? data.reasoning
                            : '')
                        if (reasoningDelta) {
                          thinkingAccumulated += reasoningDelta
                          persistActiveRun((runSessionKey, activeId) =>
                            setRunThinking(
                              runSessionKey,
                              activeId,
                              thinkingAccumulated,
                            ),
                          )
                          sendEvent('thinking', {
                            text: thinkingAccumulated,
                            sessionKey: sessionKeyFromEvent,
                            runId,
                          })
                        }
                        if (!delta) return
                        // Split inline <thinking> blocks out of the text stream
                        // so they render in the Activity panel instead of
                        // appearing in the visible assistant bubble.
                        assistantTextBuffer += delta
                        const displayText = publishInlineThinking(
                          sessionKeyFromEvent,
                          runId,
                        )
                        if (displayText.trim()) {
                          // displayText is the full visible (thinking-stripped)
                          // accumulation — replace, never append, so the
                          // downstream accumulators don't concatenate duplicates.
                          persistActiveRun((runSessionKey, activeId) =>
                            appendRunText(
                              runSessionKey,
                              activeId,
                              displayText,
                              { replace: true },
                            ),
                          )
                          sendEvent('chunk', {
                            text: displayText,
                            fullReplace: true,
                            sessionKey: sessionKeyFromEvent,
                            runId,
                          })
                          skipPublish ||
                            publishChatEvent('chunk', {
                              text: displayText,
                              fullReplace: true,
                              sessionKey: sessionKeyFromEvent,
                              runId,
                            })
                        }
                        return
                      }

                      if (
                        event === 'tool.pending' ||
                        event === 'tool.started' ||
                        event === 'tool.calling' ||
                        event === 'tool.running'
                      ) {
                        const toolName = getToolName(data)
                        const preview =
                          typeof data.preview === 'string'
                            ? data.preview
                            : undefined
                        const translated = {
                          phase:
                            event === 'tool.pending' || event === 'tool.started'
                              ? 'start'
                              : 'calling',
                          name: toolName,
                          toolCallId: getToolCallId(data, runId, toolName),
                          args: getToolArgs(data),
                          preview,
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          upsertRunToolCall(runSessionKey, activeId, {
                            id: translated.toolCallId,
                            name: toolName,
                            phase: translated.phase,
                            args: translated.args,
                            preview,
                          }),
                        )
                        sendEvent('tool', translated)
                        skipPublish || publishChatEvent('tool', translated)
                        lastActivity = `Running: ${toolName.replace(/_/g, ' ')}`
                        return
                      }

                      if (event === 'tool.progress') {
                        const delta = readString(data.delta)
                        const toolName = getToolName(data)
                        const reasonDelta =
                          extractReasoningFromToolProgress(data)
                        if (reasonDelta !== null) {
                          // tool.progress deltas are incremental; accumulate
                          // them so the activity card shows the full thinking
                          // chain instead of only the latest fragment.
                          thinkingAccumulated += reasonDelta
                          persistActiveRun((runSessionKey, activeId) =>
                            setRunThinking(
                              runSessionKey,
                              activeId,
                              thinkingAccumulated,
                            ),
                          )
                          const translated = {
                            text: thinkingAccumulated,
                            sessionKey: sessionKeyFromEvent,
                            runId,
                          }
                          sendEvent('thinking', translated)
                          skipPublish ||
                            publishChatEvent('thinking', translated)
                          lastActivity =
                            thinkingAccumulated.length > 60
                              ? thinkingAccumulated.slice(0, 60) + '...'
                              : thinkingAccumulated
                          return
                        }
                        const translated = {
                          phase: 'calling',
                          name: toolName,
                          toolCallId: getToolCallId(data, runId, toolName),
                          args: getToolArgs(data),
                          result: delta || undefined,
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          upsertRunToolCall(runSessionKey, activeId, {
                            id: translated.toolCallId,
                            name: toolName,
                            phase: 'calling',
                            args: translated.args,
                            result: translated.result,
                          }),
                        )
                        sendEvent('tool', translated)
                        skipPublish || publishChatEvent('tool', translated)
                        return
                      }

                      if (event === 'tool.completed') {
                        const toolName = getToolName(data)
                        const resultPreview = getToolResultPreview(data)
                        const translated = {
                          phase: 'complete',
                          name: toolName,
                          toolCallId: getToolCallId(data, runId, toolName),
                          args: getToolArgs(data),
                          result: resultPreview.slice(0, 4000),
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          upsertRunToolCall(runSessionKey, activeId, {
                            id: translated.toolCallId,
                            name: toolName,
                            phase: 'complete',
                            args: translated.args,
                            result: translated.result,
                          }),
                        )
                        sendEvent('tool', translated)
                        skipPublish || publishChatEvent('tool', translated)
                        lastActivity = `Completed: ${toolName.replace(/_/g, ' ')}`
                        return
                      }

                      if (event === 'artifact.created') {
                        const artifact =
                          data.artifact && typeof data.artifact === 'object'
                            ? (data.artifact as Record<string, unknown>)
                            : {}
                        const translated = {
                          name: readString(data.tool_name) || 'artifact',
                          title:
                            readString(artifact.title) ||
                            readString(data.title) ||
                            'Artifact created',
                          kind:
                            readString(artifact.kind) ||
                            readString(data.kind) ||
                            'artifact',
                          path:
                            readString(artifact.path) ||
                            readString(data.path) ||
                            '',
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        sendEvent('artifact', translated)
                        skipPublish || publishChatEvent('artifact', translated)
                        return
                      }

                      if (event === 'memory.updated') {
                        const translated = {
                          phase: 'complete',
                          name: 'memory',
                          toolCallId:
                            readString(data.tool_call_id) || undefined,
                          result:
                            readString(data.message) ||
                            `Updated ${readString(data.target) || 'memory'}`,
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          upsertRunToolCall(runSessionKey, activeId, {
                            id:
                              translated.toolCallId ||
                              `${runId || 'run'}:memory`,
                            name: 'memory',
                            phase: 'complete',
                            result: translated.result,
                          }),
                        )
                        sendEvent('tool', translated)
                        skipPublish || publishChatEvent('tool', translated)
                        return
                      }

                      if (event === 'skill.loaded') {
                        const skill =
                          data.skill && typeof data.skill === 'object'
                            ? (data.skill as Record<string, unknown>)
                            : {}
                        const translated = {
                          phase: 'complete',
                          name: 'skill',
                          toolCallId:
                            readString(data.tool_call_id) || undefined,
                          result:
                            readString(skill.name) ||
                            readString(data.skill_name) ||
                            'Skill loaded',
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          upsertRunToolCall(runSessionKey, activeId, {
                            id:
                              translated.toolCallId ||
                              `${runId || 'run'}:skill`,
                            name: 'skill',
                            phase: 'complete',
                            result: translated.result,
                          }),
                        )
                        sendEvent('tool', translated)
                        skipPublish || publishChatEvent('tool', translated)
                        return
                      }

                      if (event === 'tool.failed') {
                        const errorMessage =
                          readString(
                            (data.error as Record<string, unknown> | undefined)
                              ?.message,
                          ) || readString(data.message)
                        const toolName = getToolName(data)
                        const translated = {
                          phase: 'error',
                          name: toolName,
                          toolCallId: getToolCallId(data, runId, toolName),
                          result: errorMessage,
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          upsertRunToolCall(runSessionKey, activeId, {
                            id: translated.toolCallId,
                            name: toolName,
                            phase: 'error',
                            result: translated.result,
                          }),
                        )
                        sendEvent('tool', translated)
                        skipPublish || publishChatEvent('tool', translated)
                        return
                      }

                      if (event === 'error') {
                        const errorMessage =
                          readString(
                            (data.error as Record<string, unknown> | undefined)
                              ?.message,
                          ) ||
                          readString(data.message) ||
                          'Hermes stream error'
                        persistActiveRun((runSessionKey, activeId) =>
                          markRunStatus(
                            runSessionKey,
                            activeId,
                            'error',
                            errorMessage,
                          ),
                        )
                        sendEvent('error', {
                          message: errorMessage,
                          sessionKey: sessionKeyFromEvent,
                          runId,
                        })
                        closeStream()
                        return
                      }

                      if (event === 'run.completed') {
                        // Backfill tool calls from session history.
                        // Hermes Agent currently does not stream tool.* events
                        // reliably, but it persists tool calls on the assistant
                        // message. Fetch the latest assistant message and emit
                        // synthetic 'tool' events for each tool call so the
                        // Workspace UI can render the Activity card.
                        try {
                          const sid =
                            readString(data.session_id) ||
                            sessionKeyFromEvent ||
                            ''
                          if (sid) {
                            let persistedMessages: Array<
                              Record<string, unknown>
                            > = []
                            try {
                              persistedMessages =
                                (await getSessionMessagesFromAgent(
                                  sid,
                                )) as unknown as Array<Record<string, unknown>>
                            } catch {
                              persistedMessages = []
                            }
                            // Walk back to the most recent assistant message in
                            // this run; tool_calls are siblings on it. Also
                            // collect tool_result entries that immediately
                            // follow it so we can pair input/output.
                            // Use the per-run baseline so we never read tool
                            // calls from a previous turn.
                            const sliceFrom = Math.max(
                              0,
                              Math.min(
                                liveBaselineCount,
                                Math.max(0, persistedMessages.length - 1),
                              ),
                            )
                            const recent = persistedMessages.slice(sliceFrom)
                            let lastAssistantIndex = -1
                            for (let i = recent.length - 1; i >= 0; i--) {
                              const m = recent[i]
                              if (m && m.role === 'assistant') {
                                lastAssistantIndex = i
                                break
                              }
                            }
                            if (lastAssistantIndex >= 0) {
                              const lastAssistant = recent[lastAssistantIndex]
                              const rawToolCalls = (lastAssistant.tool_calls ??
                                (lastAssistant as any).toolCalls) as
                                | Array<Record<string, unknown>>
                                | undefined
                              const toolCalls =
                                Array.isArray(rawToolCalls) &&
                                rawToolCalls.length
                                  ? rawToolCalls
                                  : []

                              const syntheticEvents =
                                collectSyntheticLiveToolEvents({
                                  messages: recent,
                                  tracker: syntheticLiveToolTracker,
                                  sessionKey: sessionKeyFromEvent,
                                  runId,
                                })
                              for (const synthetic of syntheticEvents) {
                                persistActiveRun((runSessionKey, activeId) =>
                                  upsertRunToolCall(runSessionKey, activeId, {
                                    id: synthetic.toolCallId,
                                    name: synthetic.name,
                                    phase: synthetic.phase,
                                    args: synthetic.args,
                                    result: synthetic.result,
                                  }),
                                )
                                sendEvent('tool', synthetic)
                                skipPublish ||
                                  publishChatEvent('tool', synthetic)
                              }
                            }
                          }
                        } catch (err) {
                          // Backfill is best-effort; don't fail the run.
                          console.warn(
                            '[send-stream] tool backfill failed:',
                            err,
                          )
                        }

                        // Final flush so done.message carries thinking-stripped
                        // body text (Tutti settling backfill / host stamp).
                        const finalDisplayText = publishInlineThinking(
                          sessionKeyFromEvent,
                          runId,
                        )
                        const doneContent: Array<Record<string, string>> = []
                        if (thinkingAccumulated.trim()) {
                          doneContent.push({
                            type: 'thinking',
                            thinking: thinkingAccumulated.trim(),
                          })
                        }
                        if (finalDisplayText.trim()) {
                          doneContent.push({
                            type: 'text',
                            text: finalDisplayText.trim(),
                          })
                        }
                        const translated = {
                          state: 'complete',
                          sessionKey: sessionKeyFromEvent,
                          runId,
                          ...(doneContent.length > 0
                            ? {
                                message: {
                                  role: 'assistant',
                                  content: doneContent,
                                },
                              }
                            : {}),
                        }
                        persistActiveRun((runSessionKey, activeId) =>
                          markRunStatus(runSessionKey, activeId, 'complete'),
                        )
                        if (runId) clearRunDetached(runId)
                        sendEvent('done', translated)
                        skipPublish || publishChatEvent('done', translated)
                        closeStream()
                      }
                    },
                  },
                )
              } finally {
                // Stop the mid-run tool poller and let it drain.
                liveRunActive = false
                try {
                  await livePollerPromise
                } catch {
                  // ignore
                }
              }

              // Set a timeout to close the stream if no completion event
              streamTimeoutTimer = setTimeout(() => {
                if (!streamClosed) {
                  sendEvent('error', { message: 'Stream timeout' })
                  closeStream()
                }
              }, SEND_STREAM_RUN_TIMEOUT_MS)
            } catch (err) {
              // Only send error if stream hasn't already completed successfully
              if (!streamClosed) {
                const errorMsg = normalizeClaudeErrorMessage(err)
                sendEvent('error', {
                  message: errorMsg,
                  sessionKey,
                })
                closeStream()
              }
            }
          },
          cancel() {
            handleClientDisconnect()
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...buildResolvedSessionHeaders({
              sessionKey,
              friendlyId: resolvedFriendlyId,
            }),
          },
        })
      },
    },
  },
})
