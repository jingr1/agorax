// Client-safe SSE bridge for the Agorax managed-agent event route.
//
// The server forwards daemon activity frames as named SSE events:
//   `connected`  -> {"workspaceId": "..."}            (on every (re)connect)
//   `activity`   -> full agent.activity.updated envelope
//   `reconnect`  -> {"reason": "daemon-ws-drop" | "daemon-ws-reconnect"}
//
// The bridge validates + normalizes envelopes, microtask-batches `activity`
// deliveries, and reports transport state so the host can reconcile after
// reconnects. It owns no engine state; the hook assembles engine/coordinator.

import {
  agentActivityEventEnvelopeIsConsistent,
  type AgentActivityUpdatedEvent,
  type AgentActivityWorkspaceEventInput,
} from '@agorax/agent-activity-core'

export const MANAGED_AGENT_ACTIVITY_TOPIC = 'agent.activity.updated'

/** Payload of one `activity` envelope: the canonical updated-event shape. */
export type ManagedAgentActivityEventPayload = AgentActivityWorkspaceEventInput

export interface ManagedAgentActivityEventEnvelope {
  id: string
  topic: string
  version: number
  emittedAt: string
  scope: { workspaceId: string }
  payload: ManagedAgentActivityEventPayload
}

export interface ManagedAgentEventSourceMessage {
  data?: unknown
}

/** Minimal EventSource surface so tests can inject a fake transport. */
export interface ManagedAgentEventSourceLike {
  readonly readyState: number
  close(): void
  addEventListener(
    type: string,
    listener: (message: ManagedAgentEventSourceMessage) => void,
  ): void
}

export type ManagedAgentEventSourceFactory = (
  url: string,
) => ManagedAgentEventSourceLike

export const MANAGED_AGENT_EVENT_SOURCE_CONNECTING = 0
export const MANAGED_AGENT_EVENT_SOURCE_OPEN = 1
export const MANAGED_AGENT_EVENT_SOURCE_CLOSED = 2

export const MANAGED_AGENT_EVENT_BRIDGE_DEFAULT_RECONNECT_DELAY_MS = 3_000

export interface ManagedAgentEventBridge {
  dispose(): void
}

export interface CreateManagedAgentEventBridgeInput {
  agentId: string
  displaySessionId: string
  eventsUrl?: (agentId: string, displaySessionId: string) => string
  createEventSource?: ManagedAgentEventSourceFactory
  scheduleFlush?: (flush: () => void) => void
  reconnectDelayMs?: number
  onConnected: (workspaceId: string) => void
  onActivity: (
    payload: ManagedAgentActivityEventPayload,
    envelope: ManagedAgentActivityEventEnvelope,
  ) => void
  /** One `activity` frame failed parse/validation; host should reconcile. */
  onMalformedActivity?: (raw: unknown) => void
  /** Server-signaled daemon transport drop/reconnect; host should reconcile. */
  onReconnectRequested?: (reason: string) => void
  onTransportDisconnected?: () => void
}

export function managedAgentSessionEventsUrl(
  agentId: string,
  displaySessionId: string,
): string {
  return `/api/agents/${encodeURIComponent(agentId)}/engine/session/${encodeURIComponent(displaySessionId)}/events`
}

export function createManagedAgentEventBridge(
  input: CreateManagedAgentEventBridgeInput,
): ManagedAgentEventBridge {
  const createEventSource =
    input.createEventSource ??
    ((url: string) => new EventSource(url) as unknown as ManagedAgentEventSourceLike)
  const scheduleFlush = input.scheduleFlush ?? ((flush: () => void) => queueMicrotask(flush))
  const reconnectDelayMs =
    input.reconnectDelayMs ?? MANAGED_AGENT_EVENT_BRIDGE_DEFAULT_RECONNECT_DELAY_MS
  const eventsUrl =
    input.eventsUrl ?? managedAgentSessionEventsUrl

  let disposed = false
  let source: ManagedAgentEventSourceLike | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let flushScheduled = false
  let pendingPayloads: ManagedAgentActivityEventPayload[] = []
  let pendingEnvelopes: ManagedAgentActivityEventEnvelope[] = []
  let transportDisconnectedSignaled = false

  const open = (): void => {
    if (disposed) return
    const next = createEventSource(eventsUrl(input.agentId, input.displaySessionId))
    source = next
    transportDisconnectedSignaled = false
    next.addEventListener('connected', (message) => {
      const workspaceId = parseConnectedWorkspaceId(readMessageData(message))
      if (workspaceId) input.onConnected(workspaceId)
    })
    next.addEventListener('activity', (message) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(readMessageData(message)))
      } catch {
        input.onMalformedActivity?.(undefined)
        return
      }
      const parsed = parseManagedAgentActivityEnvelope(raw)
      if (!parsed) {
        input.onMalformedActivity?.(raw)
        return
      }
      pendingPayloads.push(parsed.payload)
      pendingEnvelopes.push(parsed.envelope)
      scheduleFlushOnce()
    })
    next.addEventListener('reconnect', (message) => {
      input.onReconnectRequested?.(parseReconnectReason(readMessageData(message)))
    })
    next.addEventListener('error', () => {
      if (disposed || source !== next) return
      if (!transportDisconnectedSignaled) {
        transportDisconnectedSignaled = true
        input.onTransportDisconnected?.()
      }
      // EventSource auto-reconnects while CONNECTING; only a CLOSED source
      // needs an explicit re-open, which yields a fresh `connected` frame so
      // the host can run a gap-closing reconcile.
      if (next.readyState === MANAGED_AGENT_EVENT_SOURCE_CLOSED) {
        next.close()
        scheduleReconnect()
      }
    })
  }

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!disposed) open()
    }, reconnectDelayMs)
  }

  const scheduleFlushOnce = (): void => {
    if (flushScheduled) return
    flushScheduled = true
    scheduleFlush(() => {
      flushScheduled = false
      if (disposed) {
        pendingPayloads = []
        pendingEnvelopes = []
        return
      }
      const payloads = pendingPayloads
      const envelopes = pendingEnvelopes
      pendingPayloads = []
      pendingEnvelopes = []
      for (let index = 0; index < payloads.length; index += 1) {
        input.onActivity(payloads[index], envelopes[index])
      }
    })
  }

  open()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      source?.close()
      source = null
    },
  }
}

function readMessageData(message: ManagedAgentEventSourceMessage): unknown {
  return message?.data
}

export function parseConnectedWorkspaceId(raw: unknown): string | null {
  const workspaceId = readTrimmedString(parseJsonSafe(raw)?.workspaceId)
  return workspaceId || null
}

export function parseReconnectReason(raw: unknown): string {
  return readTrimmedString(parseJsonSafe(raw)?.reason) ?? 'daemon-ws-reconnect'
}

export interface ParsedManagedAgentActivityEnvelope {
  envelope: ManagedAgentActivityEventEnvelope
  payload: ManagedAgentActivityEventPayload
}

/**
 * Validates one raw `activity` SSE frame against the envelope contract and
 * the core envelope-consistency rules. Transport payloads that omit the
 * redundant per-`data` identity fields are normalized before validation (the
 * daemon delta frames historically only carried them at the payload root).
 */
export function parseManagedAgentActivityEnvelope(
  raw: unknown,
): ParsedManagedAgentActivityEnvelope | null {
  const record = asRecord(parseJsonValue(raw))
  if (!record || record.topic !== MANAGED_AGENT_ACTIVITY_TOPIC) return null
  const scope = asRecord(record.scope)
  const payload = asRecord(record.payload)
  const scopeWorkspaceId = readTrimmedString(scope?.workspaceId)
  if (!scopeWorkspaceId || !payload) return null
  const normalized = normalizeActivityPayload(payload)
  if (!normalized) return null
  if (
    !agentActivityEventEnvelopeIsConsistent(
      normalized as unknown as AgentActivityUpdatedEvent,
    )
  ) {
    return null
  }
  return {
    envelope: {
      id: readTrimmedString(record.id) ?? '',
      topic: MANAGED_AGENT_ACTIVITY_TOPIC,
      version:
        typeof record.version === 'number' && Number.isSafeInteger(record.version)
          ? record.version
          : 0,
      emittedAt: readTrimmedString(record.emittedAt) ?? '',
      scope: { workspaceId: scopeWorkspaceId },
      payload: normalized,
    },
    payload: normalized,
  }
}

function normalizeActivityPayload(
  payload: Record<string, unknown>,
): ManagedAgentActivityEventPayload | null {
  const workspaceId = readTrimmedString(payload.workspaceId)
  const agentSessionId = readTrimmedString(payload.agentSessionId)
  const eventType = readTrimmedString(payload.eventType)
  if (!workspaceId || !agentSessionId || !eventType) return null
  const data = asRecord(payload.data) ?? {}
  const normalizedData = {
    ...data,
    workspaceId: readTrimmedString(data.workspaceId) ?? workspaceId,
    agentSessionId: readTrimmedString(data.agentSessionId) ?? agentSessionId,
    eventType: readTrimmedString(data.eventType) ?? eventType,
  }
  return {
    workspaceId,
    agentSessionId,
    eventType,
    data: normalizedData,
  } as ManagedAgentActivityEventPayload
}

function parseJsonSafe(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return asRecord(raw)
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}
