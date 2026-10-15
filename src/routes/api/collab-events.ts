import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  ensureBusStarted,
  subscribeToChatEvents,
} from '../../server/chat-event-bus'
import { startAgentStatusWatcher } from '../../server/agent-status-watcher'

/**
 * SSE endpoint for collaboration events (rooms, agent status, human attention).
 * Supports scope / roomId / sessionKey filtering for targeted subscriptions.
 */
export const Route = createFileRoute('/api/collab-events')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const url = new URL(request.url)
        const sessionKey =
          url.searchParams.get('sessionKey')?.trim() || undefined
        const roomId = url.searchParams.get('roomId')?.trim() || undefined
        const scope = url.searchParams.get('scope')?.trim() || undefined

        startAgentStatusWatcher()
        const encoder = new TextEncoder()
        let streamClosed = false
        let unsubscribe: (() => void) | null = null
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null

        const stream = new ReadableStream({
          async start(controller) {
            const sendEvent = (event: string, data: unknown) => {
              if (streamClosed) return
              try {
                const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
                controller.enqueue(encoder.encode(payload))
              } catch {
                /* stream closed */
              }
            }

            const closeStream = () => {
              if (streamClosed) return
              streamClosed = true
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              if (unsubscribe) {
                unsubscribe()
                unsubscribe = null
              }
              try {
                controller.close()
              } catch {
                /* already closed */
              }
            }

            await ensureBusStarted()
            unsubscribe = subscribeToChatEvents(
              (evt) => sendEvent(evt.event, evt.data),
              { sessionKey, roomId, scope },
            )

            heartbeatTimer = setInterval(() => {
              sendEvent('heartbeat', { ts: Date.now() })
            }, 30_000)

            request.signal.addEventListener('abort', closeStream)
          },
          cancel() {
            if (heartbeatTimer) clearInterval(heartbeatTimer)
            if (unsubscribe) unsubscribe()
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      },
    },
  },
})
