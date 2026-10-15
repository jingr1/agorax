import { hasActiveSendRun } from './send-run-tracker'

export interface ChatSSEEvent {
  event: string
  data: Record<string, unknown>
}

type ChatSSESubscriber = (event: ChatSSEEvent) => void

// ─── Singleton state (survives Vite HMR via globalThis) ─────────────────

const BUS_KEY = '__claude_chat_event_bus__' as const

interface BusState {
  subscribers: Set<ChatSSESubscriber>
  started: boolean
}

function getBus(): BusState {
  if (!(globalThis as any)[BUS_KEY]) {
    ;(globalThis as any)[BUS_KEY] = {
      subscribers: new Set<ChatSSESubscriber>(),
      started: false,
    }
  }
  return (globalThis as any)[BUS_KEY]
}

function broadcast(event: string, data: Record<string, unknown>): void {
  const bus = getBus()
  const evt: ChatSSEEvent = { event, data }
  for (const sub of bus.subscribers) {
    try {
      sub(evt)
    } catch {
      // subscriber error — don't crash the bus
    }
  }
}

export function publishChatEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  const runId = typeof data.runId === 'string' ? data.runId : undefined
  if (hasActiveSendRun(runId)) return
  broadcast(event, data)
}

export async function ensureBusStarted(): Promise<void> {
  const bus = getBus()
  if (bus.started) return
  bus.started = true
}

export type ChatEventFilter = {
  sessionKey?: string
  roomId?: string
  scope?: string
}

export function subscribeToChatEvents(
  subscriber: ChatSSESubscriber,
  filter?: ChatEventFilter | string,
): () => void {
  const bus = getBus()

  // Backwards compatible: a bare string is treated as sessionKeyFilter.
  const normalized: ChatEventFilter =
    typeof filter === 'string' ? { sessionKey: filter } : (filter ?? {})

  const wrappedSubscriber: ChatSSESubscriber = (event) => {
    if (normalized.sessionKey) {
      const eventSessionKey = event.data.sessionKey as string | undefined
      if (eventSessionKey && eventSessionKey !== normalized.sessionKey) return
    }
    if (normalized.roomId) {
      const eventRoomId = event.data.roomId as string | undefined
      if (eventRoomId !== normalized.roomId) return
    }
    if (normalized.scope) {
      const eventScope = event.data.scope as string | undefined
      if (eventScope !== normalized.scope) return
    }
    const runId =
      typeof event.data.runId === 'string' ? event.data.runId : undefined
    if (hasActiveSendRun(runId)) return
    subscriber(event)
  }

  bus.subscribers.add(wrappedSubscriber)
  return () => {
    bus.subscribers.delete(wrappedSubscriber)
  }
}
