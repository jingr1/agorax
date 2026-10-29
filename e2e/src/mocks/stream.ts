import type { Page } from '@playwright/test'

export interface MockMessage {
  id: string
  messageId: string
  role: 'user' | 'assistant'
  content: Array<{ type: 'text'; text: string }>
  timestamp: number
  clientId?: string
}

export interface MockTurn {
  sessionKey: string
  message: string
  runId: string
  idempotencyKey: string
}

export async function installStreamMock(
  page: Page,
  histories: Map<string, Array<MockMessage>>,
) {
  const turns: Array<MockTurn> = []
  let failNext = false
  await page.exposeFunction(
    '__agoraxBeginChat',
    (input: Omit<MockTurn, 'runId'>) => {
      const turn = { ...input, runId: `run-${crypto.randomUUID()}` }
      turns.push(turn)
      const failed = failNext
      failNext = false
      if (!failed) {
        const history = histories.get(input.sessionKey)
        if (!history)
          throw new Error(`Unknown mock session: ${input.sessionKey}`)
        history.push({
          id: input.idempotencyKey,
          messageId: input.idempotencyKey,
          clientId: input.idempotencyKey,
          role: 'user',
          content: [{ type: 'text', text: input.message }],
          timestamp: Date.now(),
        })
      }
      return { ...turn, failed }
    },
  )
  await page.addInitScript({
    content: `(() => {
    const originalFetch = window.fetch.bind(window)
    const streams = new Map()
    window.__agoraxFinishChat = ({ sessionKey, text, state }) => {
      const stream = streams.get(sessionKey)
      if (!stream) throw new Error('No open mock stream for ' + sessionKey)
      stream.frame('done', { runId: stream.runId, state, message: { role: 'assistant', content: [{ type: 'text', text }] } })
      stream.controller.close()
      streams.delete(sessionKey)
    }
    window.fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), location.href), init)
      if (new URL(request.url).pathname !== '/api/send-stream') return originalFetch(input, init)
      const body = await request.clone().json()
      const turn = await window.__agoraxBeginChat(body)
      if (turn.failed) return new Response('E2E temporary service failure', { status: 503 })
      const encoder = new TextEncoder()
      let closed = false
      const stream = new ReadableStream({
        start(controller) {
          const frame = (event, data) => controller.enqueue(encoder.encode('event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'))
          streams.set(turn.sessionKey, { runId: turn.runId, controller, frame })
          frame('started', { runId: turn.runId, sessionKey: turn.sessionKey, friendlyId: turn.sessionKey, messageId: 'assistant:' + turn.runId })
          frame('chunk', { runId: turn.runId, text: 'E2E streaming response: ' + turn.message })
          request.signal.addEventListener('abort', () => {
            if (closed) return
            closed = true
            streams.delete(turn.sessionKey)
            controller.error(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        },
        cancel() { closed = true; streams.delete(turn.sessionKey) }
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-session-key': turn.sessionKey, 'x-friendly-id': turn.sessionKey } })
    }
  })()`,
  })
  return {
    turns,
    failNext: () => {
      failNext = true
    },
    complete: async (sessionKey: string, text: string) => {
      const turn = [...turns]
        .reverse()
        .find((candidate) => candidate.sessionKey === sessionKey)
      if (!turn) throw new Error(`No turn for ${sessionKey}`)
      histories
        .get(sessionKey)!
        .push({
          id: `assistant:${turn.runId}`,
          messageId: `assistant:${turn.runId}`,
          role: 'assistant',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
        })
      await page.evaluate(
        (payload) => Reflect.get(window, '__agoraxFinishChat')(payload),
        { sessionKey, text, state: 'complete' },
      )
    },
  }
}
