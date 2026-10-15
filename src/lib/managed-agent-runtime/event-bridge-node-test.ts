/**
 * node --test coverage for the managed-agent SSE event bridge: envelope
 * validation, microtask batching, and reconnect behavior. Run with:
 *
 *   ~/.nvm/versions/node/v22.22.3/bin/node \
 *     --test --experimental-strip-types \
 *     src/lib/managed-agent-runtime/event-bridge-node-test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createManagedAgentEventBridge,
  MANAGED_AGENT_EVENT_SOURCE_CLOSED,
  MANAGED_AGENT_EVENT_SOURCE_CONNECTING,
  parseManagedAgentActivityEnvelope,
  type ManagedAgentEventSourceLike,
  type ManagedAgentEventSourceMessage,
} from './event-bridge.ts'

const WS = 'workspace-1'
const SES = 'session-1'

function activityFrame(eventType = 'message_delta'): string {
  return JSON.stringify({
    id: 'evt-1',
    topic: 'agent.activity.updated',
    version: 1,
    emittedAt: '2026-09-18T00:00:00Z',
    scope: { workspaceId: WS },
    payload: {
      workspaceId: WS,
      agentSessionId: SES,
      eventType,
      data: {
        workspaceId: WS,
        agentSessionId: SES,
        eventType,
        messages: [],
      },
    },
  })
}

class FakeEventSource implements ManagedAgentEventSourceLike {
  readyState: number = MANAGED_AGENT_EVENT_SOURCE_CONNECTING
  readonly listeners = new Map<string, Array<(message: ManagedAgentEventSourceMessage) => void>>()
  closed = false

  addEventListener(type: string, listener: (message: ManagedAgentEventSourceMessage) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data })
    }
  }

  close(): void {
    this.closed = true
    this.readyState = MANAGED_AGENT_EVENT_SOURCE_CLOSED
  }
}

describe('parseManagedAgentActivityEnvelope', () => {
  it('accepts a consistent envelope and normalizes it', () => {
    const parsed = parseManagedAgentActivityEnvelope(activityFrame())
    assert.ok(parsed)
    assert.equal(parsed.envelope.topic, 'agent.activity.updated')
    assert.equal(parsed.envelope.scope.workspaceId, WS)
    assert.equal(parsed.payload.agentSessionId, SES)
    assert.equal(parsed.payload.eventType, 'message_delta')
    assert.ok(typeof parsed.payload.data === 'object' && parsed.payload.data !== null)
    assert.equal(
      (parsed.payload.data as Record<string, unknown>).eventType,
      'message_delta',
    )
  })

  it('rejects a mismatched topic', () => {
    const frame = JSON.parse(activityFrame()) as { topic: string }
    frame.topic = 'something.else'
    assert.equal(parseManagedAgentActivityEnvelope(JSON.stringify(frame)), null)
  })

  it('carries the scope through without cross-validating it against the payload', () => {
    // The consistency contract validates the payload's internal identity
    // (workspaceId/agentSessionId/eventType agreement); the envelope scope is
    // carried into the parsed envelope, not compared against the payload.
    const frame = JSON.parse(activityFrame()) as { scope: { workspaceId: string } }
    frame.scope.workspaceId = 'workspace-other'
    const parsed = parseManagedAgentActivityEnvelope(JSON.stringify(frame))
    assert.ok(parsed)
    assert.equal(parsed.envelope.scope.workspaceId, 'workspace-other')
    assert.equal(parsed.payload.workspaceId, WS)
  })

  it('rejects inconsistent payload data identity', () => {
    const frame = JSON.parse(activityFrame()) as {
      payload: { data: { agentSessionId: string } }
    }
    frame.payload.data.agentSessionId = 'session-other'
    assert.equal(parseManagedAgentActivityEnvelope(JSON.stringify(frame)), null)
  })

  it('rejects non-JSON and non-object frames', () => {
    assert.equal(parseManagedAgentActivityEnvelope('not json'), null)
    assert.equal(parseManagedAgentActivityEnvelope(42), null)
    assert.equal(parseManagedAgentActivityEnvelope(null), null)
  })
})

describe('createManagedAgentEventBridge', () => {
  it('microtask-batches activity frames into one flush', async () => {
    const sources: FakeEventSource[] = []
    const activities: string[] = []
    let flushes = 0
    const bridge = createManagedAgentEventBridge({
      agentId: 'codex-impl',
      displaySessionId: 'display-1',
      createEventSource: () => {
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
      scheduleFlush: (flush) => {
        flushes += 1
        queueMicrotask(flush)
      },
      onConnected: () => undefined,
      onActivity: (payload) => activities.push(payload.eventType),
    })

    assert.equal(sources.length, 1)
    sources[0]!.emit('activity', activityFrame())
    sources[0]!.emit('activity', activityFrame('turn_update'))
    assert.equal(activities.length, 0, 'deliveries batch until the flush runs')
    await Promise.resolve()
    assert.deepEqual(activities, ['message_delta', 'turn_update'])
    assert.equal(flushes, 1, 'two frames share one scheduled flush')

    bridge.dispose()
  })

  it('reports malformed frames for host reconcile', () => {
    const malformed: unknown[] = []
    const sources: FakeEventSource[] = []
    const bridge = createManagedAgentEventBridge({
      agentId: 'codex-impl',
      displaySessionId: 'display-1',
      createEventSource: () => {
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
      onConnected: () => undefined,
      onActivity: () => undefined,
      onMalformedActivity: (raw) => malformed.push(raw),
    })

    sources[0]!.emit('activity', '{broken')
    sources[0]!.emit('activity', JSON.stringify({ topic: 'wrong' }))
    assert.equal(malformed.length, 2)

    bridge.dispose()
  })

  it('signals transport disconnect once and re-opens a CLOSED source', async () => {
    const sources: FakeEventSource[] = []
    const workspaces: string[] = []
    let disconnects = 0
    const bridge = createManagedAgentEventBridge({
      agentId: 'codex-impl',
      displaySessionId: 'display-1',
      reconnectDelayMs: 1,
      createEventSource: () => {
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
      onConnected: (workspaceId) => workspaces.push(workspaceId),
      onActivity: () => undefined,
      onTransportDisconnected: () => {
        disconnects += 1
      },
    })

    const first = sources[0]!
    first.readyState = MANAGED_AGENT_EVENT_SOURCE_CONNECTING
    first.emit('error', {})
    first.emit('error', {})
    assert.equal(disconnects, 1, 'CONNECTING errors signal disconnect once (EventSource auto-reconnects)')

    first.readyState = MANAGED_AGENT_EVENT_SOURCE_CLOSED
    first.emit('error', {})
    assert.equal(first.closed, true, 'CLOSED source is closed explicitly')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(sources.length, 2, 'a fresh source opens after the reconnect delay')
    sources[1]!.emit('connected', JSON.stringify({ workspaceId: WS }))
    assert.deepEqual(workspaces, [WS])

    bridge.dispose()
  })

  it('forwards server-signaled reconnect reasons', () => {
    const reasons: string[] = []
    const sources: FakeEventSource[] = []
    const bridge = createManagedAgentEventBridge({
      agentId: 'codex-impl',
      displaySessionId: 'display-1',
      createEventSource: () => {
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
      onConnected: () => undefined,
      onActivity: () => undefined,
      onReconnectRequested: (reason) => reasons.push(reason),
    })

    sources[0]!.emit('reconnect', JSON.stringify({ reason: 'daemon-ws-drop' }))
    assert.deepEqual(reasons, ['daemon-ws-drop'])

    bridge.dispose()
  })

  it('stops delivering after dispose', async () => {
    const activities: string[] = []
    const sources: FakeEventSource[] = []
    const bridge = createManagedAgentEventBridge({
      agentId: 'codex-impl',
      displaySessionId: 'display-1',
      createEventSource: () => {
        const source = new FakeEventSource()
        sources.push(source)
        return source
      },
      onConnected: () => undefined,
      onActivity: (payload) => activities.push(payload.eventType),
    })

    bridge.dispose()
    sources[0]!.emit('activity', activityFrame())
    await Promise.resolve()
    assert.equal(activities.length, 0)
  })
})
