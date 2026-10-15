import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import {
  parseAgoraxManagedActivityEnvelope,
  type AgoraxManagedAgentActivityEnvelope,
} from '../../../../../../../server/agent-runtime/agorax-managed-agent-activity-stream'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'
import WebSocket from 'ws'

/**
 * SSE → daemon WS bridge.
 *
 * Every SSE client used to open its own daemon WebSocket; now one daemon WS
 * per workspace (module-level registry + reference counting) fans frames out
 * to the subscribers whose canonical agentSessionId matches the frame payload.
 * The full daemon envelope is forwarded verbatim — events are hints, the
 * client reconciles against the canonical reads on gaps/reconnects.
 *
 * Contract (shared with the frontend event bridge):
 *   - `event: connected`  data {"workspaceId": "<AGORAX_WORKSPACE_ID>"} on attach
 *   - `event: activity`   data <full daemon envelope JSON> for matching frames
 *   - `event: reconnect`  data {"reason": "daemon-ws-drop" | "daemon-ws-reconnect"}
 */

type ActivitySubscriber = {
  /**
   * Canonical daemon session id used for frame matching. The activate route
   * binds the display→canonical mapping, so a client that attaches its stream
   * before that bind lands resolves to the raw display id; `reresolve` lets
   * the bridge recover lazily once the binding exists.
   */
  agentSessionId: string
  /** Re-resolve the display session id; returns the canonical id or null. */
  reresolve: () => Promise<string | null>
  lastReresolveAt: number
  send: (event: string, data: unknown) => void
}

type WorkspaceActivitySubscription = {
  key: string
  url: string
  workspaceId: string
  socket: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempts: number
  /** True once the daemon WS dropped, until a reconnect succeeds. */
  dropped: boolean
  stopped: boolean
  subscribers: Set<ActivitySubscriber>
}

// Registry lives on globalThis: Vite dev can evaluate this server-route module
// more than once (server handler bundle vs route manifest), and each evaluation
// would otherwise own a private subscription map — a client served by instance
// A then never sees frames arriving on instance B's socket.
const SUBSCRIPTIONS_REGISTRY_KEY = '__agorax_managed_activity_subscriptions__'

type SubscriptionsRegistry = Map<string, WorkspaceActivitySubscription>

function subscriptionsRegistry(): SubscriptionsRegistry {
  const holder = globalThis as unknown as {
    [SUBSCRIPTIONS_REGISTRY_KEY]?: SubscriptionsRegistry
  }
  if (!holder[SUBSCRIPTIONS_REGISTRY_KEY]) {
    holder[SUBSCRIPTIONS_REGISTRY_KEY] = new Map()
  }
  return holder[SUBSCRIPTIONS_REGISTRY_KEY]
}

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 15000

function subscriptionKey(baseUrl: string, workspaceId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}|${workspaceId}`
}

function daemonActivitySocketUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/v1/events/ws'
}

function broadcast(
  subscription: WorkspaceActivitySubscription,
  event: string,
  data: unknown,
): void {
  for (const subscriber of subscription.subscribers) {
    try {
      subscriber.send(event, data)
    } catch {
      // Subscriber stream is closing; its release runs on stream cancel.
    }
  }
}

function connectDaemonSocket(subscription: WorkspaceActivitySubscription): void {
  if (subscription.stopped || subscription.socket) return
  const socket = new WebSocket(subscription.url)
  subscription.socket = socket
  socket.on('message', (raw) => {
    if (subscription.stopped) return
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    const envelope: AgoraxManagedAgentActivityEnvelope | null =
      parseAgoraxManagedActivityEnvelope(parsed, subscription.workspaceId)
    if (!envelope) {
      return
    }
    const frameSessionId = envelope.payload.agentSessionId
    for (const subscriber of subscription.subscribers) {
      if (subscriber.agentSessionId !== frameSessionId) {
        // Attach-before-activate: re-resolve once per second so the stream
        // starts flowing as soon as the activate route writes the binding.
        const now = Date.now()
        if (now - subscriber.lastReresolveAt < 1000) continue
        subscriber.lastReresolveAt = now
        void subscriber.reresolve().then((resolved) => {
          if (resolved) subscriber.agentSessionId = resolved
        })
        continue
      }
      try {
        subscriber.send('activity', envelope)
      } catch {
        // Subscriber stream is closing; its release runs on stream cancel.
      }
    }
  })
  socket.on('open', () => {
    if (subscription.stopped) {
      socket.close()
      return
    }
    subscription.reconnectAttempts = 0
    if (subscription.dropped) {
      subscription.dropped = false
      broadcast(subscription, 'reconnect', { reason: 'daemon-ws-reconnect' })
    }
  })
  socket.on('error', () => {
    // ws always follows 'error' with 'close'; drop handling lives there.
    socket.close()
  })
  socket.on('close', () => {
    if (subscription.socket !== socket) return
    subscription.socket = null
    if (subscription.stopped) return
    subscription.dropped = true
    broadcast(subscription, 'reconnect', { reason: 'daemon-ws-drop' })
    scheduleReconnect(subscription)
  })
}

function scheduleReconnect(subscription: WorkspaceActivitySubscription): void {
  if (subscription.stopped || subscription.reconnectTimer) return
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** subscription.reconnectAttempts,
    RECONNECT_MAX_DELAY_MS,
  )
  subscription.reconnectAttempts += 1
  subscription.reconnectTimer = setTimeout(() => {
    subscription.reconnectTimer = null
    connectDaemonSocket(subscription)
  }, delay)
  subscription.reconnectTimer.unref?.()
}

function acquireWorkspaceActivitySubscription(input: {
  baseUrl: string
  workspaceId: string
  subscriber: ActivitySubscriber
}): () => void {
  const key = subscriptionKey(input.baseUrl, input.workspaceId)
  const registry = subscriptionsRegistry()
  let subscription = registry.get(key)
  if (!subscription) {
    subscription = {
      key,
      url: daemonActivitySocketUrl(input.baseUrl),
      workspaceId: input.workspaceId,
      socket: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      dropped: false,
      stopped: false,
      subscribers: new Set(),
    }
    registry.set(key, subscription)
    connectDaemonSocket(subscription)
  }
  subscription.subscribers.add(input.subscriber)
  let released = false
  return () => {
    if (released) return
    released = true
    subscription.subscribers.delete(input.subscriber)
    if (subscription.subscribers.size > 0) return
    stopWorkspaceActivitySubscription(subscription)
  }
}

function stopWorkspaceActivitySubscription(
  subscription: WorkspaceActivitySubscription,
): void {
  if (subscription.stopped) return
  subscription.stopped = true
  subscriptionsRegistry().delete(subscription.key)
  if (subscription.reconnectTimer) {
    clearTimeout(subscription.reconnectTimer)
    subscription.reconnectTimer = null
  }
  const socket = subscription.socket
  subscription.socket = null
  socket?.close()
  subscription.subscribers.clear()
}

export const Route = createFileRoute('/api/agents/$agentId/engine/session/$sessionId/events')({
  server: { handlers: { GET: async ({ request, params }) => {
    if (!isAuthenticated(request)) return new Response('Unauthorized', { status: 401 })
    const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
    const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
    if (!baseUrl || !workspaceId) return new Response('Managed Agent transport is not configured', { status: 503 })
    const identity = await resolveAgoraxManagedSessionIdentity({
      agentId: params.agentId,
      sessionId: params.sessionId,
    })
    if (!identity.ok) return new Response(identity.error, { status: identity.status })
    const encoder = new TextEncoder()
    let release: (() => void) | null = null
    let streamClosed = false
    return new Response(new ReadableStream({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (streamClosed) return
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          } catch {
            streamClosed = true
          }
        }
        send('connected', { workspaceId })
        release = acquireWorkspaceActivitySubscription({
          baseUrl,
          workspaceId,
          subscriber: {
            agentSessionId: identity.agentSessionId,
            reresolve: async () => {
              const resolved = await resolveAgoraxManagedSessionIdentity({
                agentId: params.agentId,
                sessionId: params.sessionId,
              })
              return resolved.ok ? resolved.agentSessionId : null
            },
            lastReresolveAt: 0,
            send,
          },
        })
        request.signal.addEventListener('abort', () => {
          streamClosed = true
          release?.()
        }, { once: true })
      },
      cancel() {
        streamClosed = true
        release?.()
      },
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
  } } },
})
