import type { Page } from '@playwright/test'

export interface MockMessage {
  id: string
  messageId: string
  role: 'user' | 'assistant'
  content: Array<{ type: 'text'; text: string }>
  timestamp: number
  clientId?: string
  turnId?: string
  runId?: string
}

export interface MockTurn {
  sessionKey: string
  message: string
  runId: string
  idempotencyKey: string
}

export type StreamTurnMode = 'immediate' | 'thinking-first'

export async function installStreamMock(
  page: Page,
  histories: Map<string, Array<MockMessage>>,
) {
  const turns: Array<MockTurn> = []
  let failNext = false
  let nextMode: StreamTurnMode = 'immediate'
  await page.exposeFunction(
    '__agoraxBeginChat',
    (input: Omit<MockTurn, 'runId'> & { mode?: StreamTurnMode }) => {
      const turn = { ...input, runId: `run-${crypto.randomUUID()}` }
      turns.push(turn)
      const failed = failNext
      failNext = false
      const mode = input.mode || nextMode
      nextMode = 'immediate'
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
          turnId: `turn-${turn.runId}`,
        })
      }
      return { ...turn, failed, mode }
    },
  )
  await page.addInitScript({
    content: `(() => {
    const originalFetch = window.fetch.bind(window)
    const streams = new Map()
    const frame = (controller, encoder, event, data) =>
      controller.enqueue(encoder.encode('event: ' + event + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'))
    window.__agoraxReleaseChatText = ({ sessionKey, text }) => {
      const stream = streams.get(sessionKey)
      if (!stream) throw new Error('No open mock stream for ' + sessionKey)
      if (stream.released) return
      stream.released = true
      frame(stream.controller, stream.encoder, 'chunk', { runId: stream.runId, text })
    }
    window.__agoraxFinishChat = ({ sessionKey, text, state }) => {
      const stream = streams.get(sessionKey)
      if (!stream) throw new Error('No open mock stream for ' + sessionKey)
      if (!stream.released) {
        stream.released = true
        frame(stream.controller, stream.encoder, 'chunk', {
          runId: stream.runId,
          text: text || ('E2E streaming response: ' + stream.message),
        })
      }
      frame(stream.controller, stream.encoder, 'done', {
        runId: stream.runId,
        state,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })
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
          const entry = {
            runId: turn.runId,
            message: turn.message,
            controller,
            encoder,
            released: false,
          }
          streams.set(turn.sessionKey, entry)
          frame(controller, encoder, 'started', {
            runId: turn.runId,
            sessionKey: turn.sessionKey,
            friendlyId: turn.sessionKey,
            messageId: 'assistant:' + turn.runId,
          })
          if (turn.mode === 'thinking-first') {
            frame(controller, encoder, 'thinking', {
              runId: turn.runId,
              text: 'E2E planning the reply',
            })
          } else {
            entry.released = true
            frame(controller, encoder, 'chunk', {
              runId: turn.runId,
              text: 'E2E streaming response: ' + turn.message,
            })
          }
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
    holdThinkingFirst: () => {
      nextMode = 'thinking-first'
    },
    releaseText: async (sessionKey: string, text?: string) => {
      const turn = [...turns]
        .reverse()
        .find((candidate) => candidate.sessionKey === sessionKey)
      if (!turn) throw new Error(`No turn for ${sessionKey}`)
      const payload = {
        sessionKey,
        text: text ?? `E2E streaming response: ${turn.message}`,
      }
      await page.evaluate(
        (value) => Reflect.get(window, '__agoraxReleaseChatText')(value),
        payload,
      )
    },
    complete: async (sessionKey: string, text: string) => {
      const turn = [...turns]
        .reverse()
        .find((candidate) => candidate.sessionKey === sessionKey)
      if (!turn) throw new Error(`No turn for ${sessionKey}`)
      histories.get(sessionKey)!.push({
        id: `assistant:${turn.runId}`,
        messageId: `assistant:${turn.runId}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
        turnId: `turn-${turn.runId}`,
        runId: turn.runId,
      })
      await page.evaluate(
        (payload) => Reflect.get(window, '__agoraxFinishChat')(payload),
        { sessionKey, text, state: 'complete' },
      )
    },
  }
}
