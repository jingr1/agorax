import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  compressSession,
  getMessages,
  oneshotCompletion,
} from '../../../server/hermes-api'
import { ensureChatGateway, enterChatGateway } from '../../../server/chat-gateway'
import {
  ensureGatewayProbed,
  getCapabilities,
} from '../../../server/gateway-capabilities'

function messageText(msg: Record<string, unknown>): string {
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '')
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function buildTranscriptDigest(
  messages: Array<Record<string, unknown>>,
  charBudget = 24_000,
): string {
  const lines: Array<string> = []
  for (const msg of messages) {
    const role = String(msg.role || '')
    if (role === 'system') continue
    const text = messageText(msg).trim()
    if (!text && role !== 'assistant') continue
    const label =
      role === 'user' ? 'USER' : role === 'assistant' ? 'ASSISTANT' : 'TOOL'
    lines.push(`${label}: ${text.slice(0, 2000)}`)
  }
  const kept: Array<string> = []
  let used = 0
  for (const line of [...lines].reverse()) {
    if (used + line.length > charBudget && kept.length > 0) break
    kept.push(line)
    used += line.length
  }
  return kept.reverse().join('\n\n')
}

export const Route = createFileRoute('/api/sessions/$sessionKey/compress')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf

        const sessionKey = params.sessionKey?.trim()
        if (!sessionKey || sessionKey === 'new' || sessionKey === 'main') {
          return json(
            { ok: false, error: 'sessionKey required' },
            { status: 400 },
          )
        }

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const focusTopic =
          typeof body.focusTopic === 'string'
            ? body.focusTopic.trim()
            : typeof body.focus_topic === 'string'
              ? body.focus_topic.trim()
              : ''
        const keepRaw = body.keepCount ?? body.keep_count ?? 6
        const keepCount = Number(keepRaw)
        if (!Number.isInteger(keepCount) || keepCount < 0) {
          return json(
            { ok: false, error: 'keepCount must be a non-negative integer' },
            { status: 400 },
          )
        }

        try {
          const requestedProfile =
            typeof body.profileName === 'string' ? body.profileName.trim() : ''
          enterChatGateway(await ensureChatGateway(requestedProfile))
          await ensureGatewayProbed()
          if (!getCapabilities().sessionCompress) {
            return json(
              {
                ok: false,
                error:
                  'Session compress is not available on this Hermes build. /compress needs upstream session_compress support — do not patch local hermes.',
                code: 'session_compress_unavailable',
              },
              { status: 501 },
            )
          }
          const messages = (await getMessages(sessionKey)) as Array<
            Record<string, unknown>
          >
          if (messages.length < 4) {
            return json(
              {
                ok: false,
                error: 'Not enough messages to compress (need at least 4)',
              },
              { status: 400 },
            )
          }

          const digest = buildTranscriptDigest(messages)
          const focusHint = focusTopic
            ? `\nPreserve details related to: ${focusTopic}\n`
            : ''
          const summary = await oneshotCompletion({
            messages: [
              {
                role: 'system',
                content:
                  'You compress conversation history into a durable handoff summary. Be dense, factual, and structured. Do not continue the task — only summarize.',
              },
              {
                role: 'user',
                content: `Summarize this conversation for context compression.${focusHint}\n\nTRANSCRIPT:\n${digest}`,
              },
            ],
          })
          if (!summary) {
            return json(
              { ok: false, error: 'Failed to generate compression summary' },
              { status: 500 },
            )
          }

          const result = await compressSession(sessionKey, {
            summary,
            keepCount,
            focusTopic: focusTopic || undefined,
          })
          return json({
            ok: true,
            beforeCount: result.before_count,
            afterCount: result.after_count,
            keepCount: result.keep_count,
            focusTopic: result.focus_topic,
            summary: result.summary,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
