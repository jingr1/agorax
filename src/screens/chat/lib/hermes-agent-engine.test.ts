import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentActivitySnapshotProjector,
  createAgentActivityWorkspaceEventCoordinator,
  selectEngineActiveTurn,
} from '@agorax/agent-activity-core'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  ingestHermesUserPromptMessage,
  reconcileHermesHistoryIntoEngine,
  selectHermesChatState,
} from './hermes-agent-engine'
import type { AgoraxRunMapping } from '@/server/agent-runtime/hermes-native-bridge'

function mappingStore() {
  const map = new Map<string, AgoraxRunMapping>()
  return {
    get: async (id: string) => map.get(id) ?? null,
    put: async (m: AgoraxRunMapping) => {
      map.set(m.agentSessionId, m)
      return m
    },
    map,
  }
}

describe('hermes-agent-engine', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/sessions') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              sessionKey: 'gw-session-1',
              friendlyId: 'friendly-1',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (url.includes('/api/send-stream')) {
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: started\ndata: ${JSON.stringify({ runId: 'run-1' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: chunk\ndata: ${JSON.stringify({ text: 'hi', fullReplace: true, runId: 'run-1' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({ state: 'complete', runId: 'run-1' })}\n\n`,
                ),
              )
              controller.close()
            },
          })
          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'X-Hermes-Session-Key': 'gw-session-1',
            },
          })
        }
        if (url.includes('/api/runs/') && url.includes('/stop')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('/api/history')) {
          return new Response(
            JSON.stringify({
              messages: [
                { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'hi' }],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activate → send → ingest → busy then settle', async () => {
    const store = mappingStore()
    const events: unknown[] = []
    const workspaceId = 'ws-test'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => events.push(event),
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    engine.dispatch({
      status: 'connected',
      type: 'engine/connectionChanged',
      workspaceId,
    })

    const activated = await commandPort.effects.activateSession(
      {
        mode: 'new',
        activationId: 'act-1',
        agentSessionId: 'agent-1',
        agentTargetId: 'hermes-native',
        clientSubmitId: 'c-1',
        workspaceId,
      },
      { commandId: 'cmd-act', origin: 'engine' },
    )
    expect(activated.activation.mode).toBe('new')
    hydrateHermesAgentEngine(engine, activated.session)
    expect(store.map.get('agent-1')?.gatewaySessionId).toBe('gw-session-1')

    for (const event of events.splice(0)) {
      coordinator.ingestEvent(event as never)
    }

    const sendPromise = commandPort.effects.sendInput(
      {
        clientSubmitId: 'c-send-1',
        workspaceId,
        agentSessionId: 'agent-1',
        content: [{ type: 'text', text: 'hello' }],
      },
      { commandId: 'cmd-send', origin: 'engine' },
    )

    // Allow microtasks so ingest runs during stream
    await Promise.resolve()
    const result = (await sendPromise) as {
      kind?: 'turn' | 'goalControl'
      turn: { phase: string }
    }
    expect(result.kind === undefined || result.kind === 'turn').toBe(true)
    if (result.kind === 'goalControl') throw new Error('unexpected')
    expect(result.turn.phase).toBe('settled')
    expect(store.map.get('agent-1')?.hermesRunId).toBe('run-1')

    for (const event of events) {
      coordinator.ingestEvent(event as never)
    }

    const chat = selectHermesChatState(engine.getSnapshot(), 'agent-1')
    expect(chat.turnBusy).toBe(false)
    expect(selectEngineActiveTurn(engine.getSnapshot(), 'agent-1')).toBeNull()
    coordinator.dispose()
  })

  it('cancelTurn stops run and settles canceled', async () => {
    const store = mappingStore()
    await store.put({
      agentSessionId: 'agent-2',
      turnId: 'turn-x',
      gatewaySessionId: 'gw-2',
      assignmentId: null,
      hermesRunId: 'run-live',
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    })
    const events: unknown[] = []
    const commandPort = createHermesCommandPort({
      workspaceId: 'ws',
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => events.push(event),
    })
    const cancel = await commandPort.effects.cancelTurn(
      {
        workspaceId: 'ws',
        agentSessionId: 'agent-2',
        turnId: 'turn-x',
      },
      { commandId: 'cmd-cancel', origin: 'engine' },
    )
    expect(cancel).toMatchObject({
      cancel: { canceled: true, reason: 'turn_canceled' },
    })
    expect(
      (cancel as { turn?: { outcome?: string } }).turn?.outcome,
    ).toBe('canceled')
    expect(events.some((e) => (e as { eventType?: string }).eventType === 'turn_update')).toBe(
      true,
    )
    expect(String(fetch).length).toBeGreaterThan(0)
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('/api/runs/run-live/stop'))).toBe(true)
  })

  it('approval SSE projects pending interaction and respond relays choice', async () => {
    const store = mappingStore()
    await store.put({
      agentSessionId: 'agent-appr',
      turnId: null,
      gatewaySessionId: 'gw-appr',
      assignmentId: null,
      hermesRunId: 'run-appr',
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/send-stream')) {
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: started\ndata: ${JSON.stringify({ runId: 'run-appr' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: approval\ndata: ${JSON.stringify({
                    event: 'approval.request',
                    run_id: 'run-appr',
                    approval_id: 'appr-1',
                    command: 'rm -rf /tmp/x',
                    choices: ['once', 'deny'],
                  })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({ state: 'complete', runId: 'run-appr' })}\n\n`,
                ),
              )
              controller.close()
            },
          })
          return new Response(stream, { status: 200 })
        }
        if (url.includes('/api/runs/') && url.includes('/approval')) {
          expect(init?.method).toBe('POST')
          expect(JSON.parse(String(init?.body))).toMatchObject({
            choice: 'once',
            approval_id: 'appr-1',
          })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (url.includes('/api/history')) {
          return new Response(
            JSON.stringify({ messages: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    )

    const workspaceId = 'ws-appr'
    let engineRef: ReturnType<typeof createHermesAgentEngine> | null = null
    let coordinatorRef: ReturnType<
      typeof createAgentActivityWorkspaceEventCoordinator
    > | null = null

    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => {
        coordinatorRef?.ingestEvent(event)
      },
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    engineRef = engine
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    coordinatorRef = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 'agent-appr',
        providerSessionId: 'gw-appr',
      }),
    )

    await commandPort.effects.sendInput(
      {
        workspaceId,
        agentSessionId: 'agent-appr',
        clientSubmitId: 'submit-appr',
        content: [{ type: 'text', text: 'please run' }],
      },
      { commandId: 'cmd-appr', origin: 'engine', signal: undefined },
    )

    const chat = selectHermesChatState(engine.getSnapshot(), 'agent-appr')
    expect(chat.interactions.map((i) => i.requestId)).toContain('appr-1')
    const turnId = chat.interactions[0]!.turnId

    const accepted = engine.submitInteractionResponse({
      agentSessionId: 'agent-appr',
      turnId,
      requestId: 'appr-1',
      optionId: 'once',
    })
    expect(accepted).toBe(true)

    await vi.waitFor(() => {
      const after = selectHermesChatState(engineRef!.getSnapshot(), 'agent-appr')
      expect(
        after.interactions.find((i) => i.requestId === 'appr-1'),
      ).toBeUndefined()
    })
  })

  it('selectHermesChatState lights busy while submitting', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 's1',
      }),
    )
    const busy = selectHermesChatState(engine.getSnapshot(), 's1', {
      isSubmitting: true,
    })
    expect(busy.turnBusy).toBe(true)
    const idle = selectHermesChatState(engine.getSnapshot(), 's1')
    expect(idle.turnBusy).toBe(false)
  })

  it('reconcileHermesHistoryIntoEngine hydrates list from history ids', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    const count = reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId: 'hist-1',
      historyMessages: [
        {
          role: 'user',
          id: 'u1',
          content: [{ type: 'text', text: 'ping' }],
          timestamp: 1,
        },
        {
          role: 'assistant',
          id: 'assistant:run-h',
          messageId: 'assistant:run-h',
          content: [{ type: 'text', text: 'pong' }],
          timestamp: 2,
        },
      ],
    })
    expect(count).toBe(2)
    const chat = selectHermesChatState(engine.getSnapshot(), 'hist-1', {
      sessionMessages: coordinator.project(projectSnapshot(engine.getSnapshot()))
        .sessionMessagesById['hist-1'],
    })
    expect(chat.messages.map((m) => m.id)).toEqual(['u1', 'assistant:run-h'])
    expect(chat.messages[1]?.content).toEqual([{ type: 'text', text: 'pong' }])
    coordinator.dispose()
  })

  it('reconcile keeps older history + trailing live turn when history lags', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId: 'stale-1',
      clientSubmitId: 'fresh',
      text: 'new prompt',
    })
    const count = reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId: 'stale-1',
      historyMessages: [
        {
          role: 'user',
          id: 'old-u',
          content: [{ type: 'text', text: 'old' }],
          timestamp: 1,
        },
      ],
    })
    expect(count).toBe(3)
    const chat = selectHermesChatState(engine.getSnapshot(), 'stale-1')
    expect(chat.messages.map((m) => m.id)).toEqual([
      'old-u',
      'user:fresh',
      'assistant:pending:stale-1:fresh',
    ])
    coordinator.dispose()
  })

  it('reconcile stamps live assistant:runId over history msg-N for the same turn', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 'dup-1',
      }),
    )
    engine.dispatch({
      type: 'message/snapshotReceived',
      messages: [
        {
          workspaceId,
          agentSessionId: 'dup-1',
          messageId: 'user:c1',
          version: 1,
          sequence: 1,
          turnId: 'turn-c1',
          role: 'user',
          kind: 'text',
          status: null,
          payload: { text: '你在干嘛？', clientSubmitId: 'c1' },
          occurredAtUnixMs: 1,
        },
        {
          workspaceId,
          agentSessionId: 'dup-1',
          messageId: 'assistant:run-live',
          version: 2,
          sequence: 2,
          turnId: 'turn-c1',
          role: 'assistant',
          kind: 'text',
          status: 'completed',
          payload: { text: '在待命，等你安排任务。' },
          occurredAtUnixMs: 2,
        },
      ],
    })
    reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId: 'dup-1',
      historyMessages: [
        {
          role: 'user',
          id: 'msg-1',
          content: [{ type: 'text', text: '你在干嘛？' }],
          timestamp: 1,
        },
        {
          role: 'assistant',
          id: 'msg-2',
          content: [{ type: 'text', text: '在待命，等你安排任务。' }],
          timestamp: 2,
        },
      ],
    })
    const chat = selectHermesChatState(engine.getSnapshot(), 'dup-1')
    expect(chat.messages.map((m) => m.id)).toEqual([
      'user:c1',
      'assistant:run-live',
    ])
    coordinator.dispose()
  })

  it('selectHermesChatState stays busy and folds dual hosts while settling', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const now = 1_700_000_100_000
    engine.dispatch({
      type: 'session/detailSnapshotReceived',
      workspaceId,
      session: {
        ...createHermesSessionSkeleton({
          workspaceId,
          agentSessionId: 'settle-busy',
          nowUnixMs: now,
        }),
        activeTurnId: 'turn-settle',
        activeTurn: {
          agentSessionId: 'settle-busy',
          turnId: 'turn-settle',
          phase: 'settling',
          origin: 'user_prompt',
          outcome: 'completed',
          error: null,
          startedAtUnixMs: now,
          settledAtUnixMs: null,
          updatedAtUnixMs: now,
        },
        latestTurn: {
          agentSessionId: 'settle-busy',
          turnId: 'turn-settle',
          phase: 'settling',
          origin: 'user_prompt',
          outcome: 'completed',
          error: null,
          startedAtUnixMs: now,
          settledAtUnixMs: null,
          updatedAtUnixMs: now,
        },
      },
      childSessions: [],
      turns: [
        {
          agentSessionId: 'settle-busy',
          turnId: 'turn-settle',
          phase: 'settling',
          origin: 'user_prompt',
          outcome: 'completed',
          error: null,
          startedAtUnixMs: now,
          settledAtUnixMs: null,
          updatedAtUnixMs: now,
        },
      ],
      messages: [],
      observedAtUnixMs: now,
    })
    engine.dispatch({
      type: 'message/snapshotReceived',
      messages: [
        {
          workspaceId,
          agentSessionId: 'settle-busy',
          messageId: 'user:u1',
          version: 1,
          sequence: 1,
          turnId: 'turn-settle',
          role: 'user',
          kind: 'text',
          status: null,
          payload: { text: 'hi' },
          occurredAtUnixMs: now,
        },
        {
          workspaceId,
          agentSessionId: 'settle-busy',
          messageId: 'assistant:run-1:thinking',
          version: 2,
          sequence: 2,
          turnId: 'turn-settle',
          role: 'assistant_thinking',
          kind: 'reasoning',
          status: 'streaming',
          payload: { text: 'thinking…' },
          occurredAtUnixMs: now + 1,
        },
        {
          workspaceId,
          agentSessionId: 'settle-busy',
          messageId: 'assistant:run-1',
          version: 3,
          sequence: 3,
          turnId: 'turn-settle',
          role: 'assistant',
          kind: 'text',
          status: 'streaming',
          payload: { text: '' },
          occurredAtUnixMs: now + 2,
        },
      ],
    })

    const chat = selectHermesChatState(engine.getSnapshot(), 'settle-busy')
    expect(chat.activeTurn?.phase).toBe('settling')
    expect(chat.turnBusy).toBe(true)
    expect(chat.isStreaming).toBe(true)
    expect(chat.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(chat.messages[1]?.id).toBe('assistant:run-1')
  })

  it('commandPort stamps done.message text after thinking-only stream', async () => {
    const store = mappingStore()
    await store.put({
      agentSessionId: 'agent-stamp',
      turnId: 'turn-prev',
      gatewaySessionId: 'gw-stamp',
      assignmentId: null,
      hermesRunId: null,
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: Date.now(),
    })
    const phases: string[] = []
    const textDeltaValues: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/send-stream')) {
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: started\ndata: ${JSON.stringify({ runId: 'run-stamp' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: thinking\ndata: ${JSON.stringify({ text: 'plan only', runId: 'run-stamp' })}\n\n`,
                ),
              )
              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({
                    state: 'complete',
                    runId: 'run-stamp',
                    message: {
                      role: 'assistant',
                      content: [
                        { type: 'thinking', thinking: 'plan only' },
                        { type: 'text', text: 'final stamped answer' },
                      ],
                    },
                  })}\n\n`,
                ),
              )
              controller.close()
            },
          })
          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'X-Hermes-Session-Key': 'gw-stamp',
            },
          })
        }
        if (url.includes('/api/history')) {
          return new Response(
            JSON.stringify({
              messages: [
                { role: 'user', content: [{ type: 'text', text: 'q' }] },
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'final stamped answer' }],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const workspaceId = 'ws'
    const engine = createHermesAgentEngine({
      workspaceId,
      commandPort: createHermesCommandPort({
        workspaceId,
        getMapping: store.get,
        putMapping: store.put,
        onActivityEvent: () => undefined,
      }),
    })
    const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId)
    const coordinator = createAgentActivityWorkspaceEventCoordinator({
      engine,
      notificationScheduler: {
        schedule(delayMs, task) {
          const timer = setTimeout(task, delayMs)
          return { cancel: () => clearTimeout(timer) }
        },
      },
      readCanonicalSnapshot: () => projectSnapshot(engine.getSnapshot()),
      workspaceId,
    })
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: store.get,
      putMapping: store.put,
      onActivityEvent: (event) => {
        coordinator.ingestEvent(event as never)
        if (event.eventType === 'turn_update') {
          const turn = (event.data as { turn?: { phase?: string } }).turn
          if (turn?.phase) phases.push(turn.phase)
        }
        if (
          event.eventType === 'message_delta' &&
          (event.data as { kind?: string }).kind === 'text'
        ) {
          const content = (event.data as { content?: { value?: string } })
            .content
          if (content?.value) textDeltaValues.push(content.value)
        }
      },
    })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 'agent-stamp',
      }),
    )
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId: 'agent-stamp',
      clientSubmitId: 'c-stamp',
      text: 'q',
    })

    const result = (await commandPort.effects.sendInput(
      {
        clientSubmitId: 'c-stamp',
        workspaceId,
        agentSessionId: 'agent-stamp',
        content: [{ type: 'text', text: 'q' }],
      },
      { commandId: 'cmd-stamp', origin: 'engine' },
    )) as { turn: { phase: string } }

    expect(result.turn.phase).toBe('settled')
    expect(phases).toContain('settling')
    expect(phases[phases.length - 1]).toBe('settled')
    expect(phases.indexOf('settling')).toBeLessThan(phases.lastIndexOf('settled'))
    expect(textDeltaValues).toContain('final stamped answer')

    const chat = selectHermesChatState(engine.getSnapshot(), 'agent-stamp', {
      sessionMessages: coordinator.project(
        projectSnapshot(engine.getSnapshot()),
      ).sessionMessagesById['agent-stamp'],
    })
    expect(chat.turnBusy).toBe(false)
    const assistant = chat.messages.find((m) => m.role === 'assistant')
    const textPart = (
      assistant?.content as Array<{ type?: string; text?: string }>
    )?.find((p) => p.type === 'text')
    expect(textPart?.text).toBe('final stamped answer')
    coordinator.dispose()
  })

  it('selectHermesChatState folds thinking + text into one assistant host', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 'fold-1',
      }),
    )
    engine.dispatch({
      type: 'message/snapshotReceived',
      messages: [
        {
          workspaceId,
          agentSessionId: 'fold-1',
          messageId: 'user:u1',
          version: 1,
          sequence: 1,
          turnId: 'turn-1',
          role: 'user',
          kind: 'text',
          status: null,
          payload: { text: '有需要我审批的吗？' },
          occurredAtUnixMs: 1,
        },
        {
          workspaceId,
          agentSessionId: 'fold-1',
          messageId: 'assistant:run-1:thinking',
          version: 2,
          sequence: 2,
          turnId: 'turn-1',
          role: 'assistant_thinking',
          kind: 'reasoning',
          status: 'completed',
          payload: { text: '用户在问有没有待审批。' },
          occurredAtUnixMs: 2,
        },
        {
          workspaceId,
          agentSessionId: 'fold-1',
          messageId: 'assistant:run-1',
          version: 3,
          sequence: 3,
          turnId: 'turn-1',
          role: 'assistant',
          kind: 'text',
          status: 'completed',
          payload: { text: '目前没有。' },
          occurredAtUnixMs: 3,
        },
      ],
    })
    const chat = selectHermesChatState(engine.getSnapshot(), 'fold-1')
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1]).toMatchObject({
      id: 'assistant:run-1',
      role: 'assistant',
    })
    const content = chat.messages[1]?.content as Array<{ type?: string }>
    expect(content?.some((part) => part.type === 'thinking')).toBe(true)
    expect(content?.some((part) => part.type === 'text')).toBe(true)
  })

  it('pending assistant host survives started→assistant:runId fold', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const occurredAtUnixMs = 1_700_000_000_000
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId: 'host-1',
      clientSubmitId: 'c-host',
      text: 'ping',
      occurredAtUnixMs,
    })
    engine.dispatch({
      type: 'message/snapshotReceived',
      messages: [
        {
          workspaceId,
          agentSessionId: 'host-1',
          messageId: 'assistant:run-live',
          version: occurredAtUnixMs + 2,
          sequence: occurredAtUnixMs + 2,
          turnId: 'turn-c-host',
          role: 'assistant',
          kind: 'text',
          status: 'streaming',
          payload: { text: 'pong' },
          occurredAtUnixMs: occurredAtUnixMs + 2,
        },
      ],
    })
    const chat = selectHermesChatState(engine.getSnapshot(), 'host-1', {
      isSubmitting: true,
    })
    expect(chat.messages.map((m) => m.id)).toEqual([
      'user:c-host',
      'assistant:pending:host-1:c-host',
    ])
    expect(chat.messages[1]).toMatchObject({
      __streamingStatus: 'streaming',
      content: [{ type: 'text', text: 'pong' }],
    })
    expect(chat.streamingMessageId).toBe('assistant:pending:host-1:c-host')
  })

  it('ingestHermesUserPromptMessage seeds user + empty assistant host', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId: 'send-1',
      clientSubmitId: 'c-99',
      text: 'hello engine',
    })
    const chat = selectHermesChatState(engine.getSnapshot(), 'send-1', {
      isSubmitting: true,
    })
    expect(chat.messages).toEqual([
      expect.objectContaining({
        id: 'user:c-99',
        role: 'user',
        content: [{ type: 'text', text: 'hello engine' }],
      }),
      expect.objectContaining({
        id: 'assistant:pending:send-1:c-99',
        role: 'assistant',
        __streamingStatus: 'streaming',
        content: [],
      }),
    ])
    expect(chat.isStreaming).toBe(true)
    expect(chat.streamingMessageId).toBe('assistant:pending:send-1:c-99')
    expect(chat.turnBusy).toBe(true)
  })
})
