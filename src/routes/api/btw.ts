import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { getMessages, oneshotCompletion } from '../../server/hermes-api'
import { ensureChatGateway, enterChatGateway } from '../../server/chat-gateway'

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
    if (!text) continue
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

export const Route = createFileRoute('/api/btw')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrf = requireJsonContentType(request)
        if (csrf) return csrf

        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const sessionId = String(body.sessionId || body.session_id || '').trim()
        const question = String(body.question || body.text || '').trim()
        if (!sessionId || sessionId === 'new') {
          return json(
            { ok: false, error: 'sessionId required' },
            { status: 400 },
          )
        }
        if (!question) {
          return json(
            { ok: false, error: 'question required' },
            { status: 400 },
          )
        }

        try {
          const requestedProfile =
            typeof body.profileName === 'string' ? body.profileName.trim() : ''
          enterChatGateway(await ensureChatGateway(requestedProfile))
          const messages = (await getMessages(sessionId)) as Array<
            Record<string, unknown>
          >
          if (messages.length === 0) {
            return json(
              { ok: false, error: 'No conversation history for /btw' },
              { status: 400 },
            )
          }
          const digest = buildTranscriptDigest(messages)
          const answer = await oneshotCompletion({
            messages: [
              {
                role: 'system',
                content:
                  'You are answering a quick SIDE question (/btw) about an ongoing conversation. Answer ONLY the side question using the transcript. Do not continue or redo the main task. Be concise. If the transcript lacks enough information, say so.',
              },
              {
                role: 'user',
                content: `TRANSCRIPT:\n${digest}\n\nSIDE QUESTION:\n${question}`,
              },
            ],
          })
          if (!answer) {
            return json(
              { ok: false, error: 'Empty /btw answer' },
              { status: 500 },
            )
          }
          return json({
            ok: true,
            question,
            answer,
            sessionId,
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
