import { describe, expect, it } from 'vitest'
import {
  createHermesActivityAdapterState,
  hermesSseToActivityEvents,
} from './hermes-activity-adapter'

const ctx = {
  workspaceId: 'ws-1',
  agentSessionId: 'sess-1',
  turnId: 'turn-1',
  runId: null as string | null,
  nowUnixMs: () => 1_700_000_000_000,
}

describe('hermesSseToActivityEvents', () => {
  it('maps started → turn running and allocates durable assistant id on chunks', () => {
    let state = createHermesActivityAdapterState()
    const started = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-9',
    })
    state = started.state
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'turn_update' }),
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            messageId: 'assistant:run-9',
            content: { operation: 'set', value: '' },
          }),
        }),
      ]),
    )
    const mid = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-9',
      text: 'Hello',
      fullReplace: true,
    })
    state = mid.state
    expect(mid.events).toHaveLength(1)
    expect(mid.events[0]).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'assistant:run-9',
        kind: 'text',
        content: { operation: 'set', value: 'Hello' },
      },
    })

    const next = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-9',
      text: 'Hello world',
      fullReplace: true,
    })
    expect(next.events[0]).toMatchObject({
      data: {
        messageId: 'assistant:run-9',
        content: { operation: 'append_text', text: ' world' },
      },
    })
  })

  it('does not invent assistant:pending when started has no runId', () => {
    let state = createHermesActivityAdapterState()
    const started = hermesSseToActivityEvents(ctx, state, 'started', {})
    state = started.state
    expect(state.assistantMessageId).toBeNull()
    expect(
      started.events.some((e) => e.eventType === 'message_delta'),
    ).toBe(false)
    const chunk = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-late',
      text: 'Answer',
      fullReplace: true,
    })
    expect(chunk.state.assistantMessageId).toBe('assistant:run-late')
    // First allocate seeds an empty anchor; body follows on the same frame.
    expect(chunk.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            messageId: 'assistant:run-late',
            content: { operation: 'set', value: 'Answer' },
          }),
        }),
      ]),
    )
  })

  it('ignores Workspace Stop UUID as assistant host identity', () => {
    let state = createHermesActivityAdapterState()
    const stopOnly = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const started = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: stopOnly,
    })
    state = started.state
    expect(state.assistantMessageId).toBeNull()
    expect(
      started.events.some((event) => event.eventType === 'message_delta'),
    ).toBe(false)

    const thinking = hermesSseToActivityEvents(ctx, state, 'thinking', {
      runId: stopOnly,
      text: 'plan first',
    })
    state = thinking.state
    expect(state.lastThinking).toBe('plan first')
    expect(state.assistantMessageId).toBeNull()
    expect(
      thinking.events.some((event) => event.eventType === 'message_delta'),
    ).toBe(false)

    const flush = hermesSseToActivityEvents(ctx, state, 'thinking', {
      runId: 'run_gateway_1',
      text: 'plan first then act',
    })
    expect(flush.state.assistantMessageId).toBe('assistant:run_gateway_1')
    expect(flush.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            messageId: 'assistant:run_gateway_1:thinking',
            content: { operation: 'set', value: 'plan first' },
          }),
        }),
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            messageId: 'assistant:run_gateway_1:thinking',
            content: {
              operation: 'append_text',
              text: ' then act',
            },
          }),
        }),
      ]),
    )
  })

  it('remints UUID shell onto durable run_* and flushes thinking', () => {
    let state = createHermesActivityAdapterState()
    // Simulate a legacy in-memory lock on a Stop UUID (pre-fix clients).
    state = {
      ...state,
      runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      assistantMessageId: 'assistant:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      thinkingMessageId:
        'assistant:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:thinking',
      lastThinking: 'buffered plan',
    }
    const out = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run_real',
      text: 'hello',
      fullReplace: true,
    })
    expect(out.state.assistantMessageId).toBe('assistant:run_real')
    expect(out.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            messageId: 'assistant:run_real:thinking',
            content: { operation: 'set', value: 'buffered plan' },
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            messageId: 'assistant:run_real',
            content: { operation: 'set', value: 'hello' },
          }),
        }),
      ]),
    )
  })

  it('maps thinking to assistant_thinking / reasoning deltas', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-t',
    }))
    const out = hermesSseToActivityEvents(ctx, state, 'thinking', {
      runId: 'run-t',
      text: 'Plan A',
    })
    expect(out.events[0]).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'assistant:run-t:thinking',
        role: 'assistant_thinking',
        kind: 'reasoning',
        content: { operation: 'set', value: 'Plan A' },
      },
    })
  })

  it('maps tool + successful done to settling (not settled)', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-x',
    }))
    const tool = hermesSseToActivityEvents(ctx, state, 'tool', {
      runId: 'run-x',
      name: 'read_file',
      toolCallId: 'tc-1',
      phase: 'complete',
      result: 'ok',
    })
    state = tool.state
    expect(tool.events[0]).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'toolcall:tc-1',
        kind: 'tool_call',
        status: 'completed',
      },
    })

    const done = hermesSseToActivityEvents(ctx, state, 'done', {
      runId: 'run-x',
      state: 'complete',
    })
    expect(
      done.events.some(
        (event) =>
          event.eventType === 'message_delta' &&
          (event.data as { status?: string }).status === 'completed' &&
          (event.data as { messageId?: string }).messageId === 'assistant:run-x',
      ),
    ).toBe(true)
    expect(done.events.at(-1)).toMatchObject({
      eventType: 'turn_update',
      data: {
        activeTurnId: 'turn-1',
        turn: {
          turnId: 'turn-1',
          phase: 'settling',
          outcome: 'completed',
        },
      },
    })
  })

  it('maps failed/interrupted done straight to settled', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-fail',
    }))
    const failed = hermesSseToActivityEvents(ctx, state, 'done', {
      runId: 'run-fail',
      state: 'error',
      errorMessage: 'boom',
    })
    expect(failed.events.at(-1)).toMatchObject({
      eventType: 'turn_update',
      data: {
        activeTurnId: null,
        turn: { phase: 'settled', outcome: 'failed' },
      },
    })

    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-int',
    }))
    const interrupted = hermesSseToActivityEvents(ctx, state, 'done', {
      runId: 'run-int',
      state: 'interrupted',
    })
    expect(interrupted.events.at(-1)).toMatchObject({
      eventType: 'turn_update',
      data: {
        activeTurnId: null,
        turn: { phase: 'settled', outcome: 'interrupted' },
      },
    })
  })

  it('applies done.message text/thinking deltas before settling', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-msg',
    }))
    const done = hermesSseToActivityEvents(ctx, state, 'done', {
      runId: 'run-msg',
      state: 'complete',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'final answer' },
        ],
      },
    })
    expect(done.state.lastText).toBe('final answer')
    expect(done.state.lastThinking).toBe('plan')
    expect(done.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            kind: 'reasoning',
            content: { operation: 'set', value: 'plan' },
          }),
        }),
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            kind: 'text',
            content: { operation: 'set', value: 'final answer' },
          }),
        }),
        expect.objectContaining({
          eventType: 'turn_update',
          data: expect.objectContaining({
            turn: expect.objectContaining({ phase: 'settling' }),
          }),
        }),
      ]),
    )
  })

  it('maps approval SSE to a pending interaction_update', () => {
    let state = createHermesActivityAdapterState()
    ;({ state } = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-appr',
    }))
    const out = hermesSseToActivityEvents(ctx, state, 'approval', {
      event: 'approval.request',
      run_id: 'run-appr',
      approval_id: 'appr-9',
      command: 'echo hi',
      description: 'Safe',
      choices: ['once', 'deny'],
    })
    expect(out.events).toHaveLength(1)
    expect(out.events[0]).toMatchObject({
      eventType: 'interaction_update',
      data: {
        interaction: {
          kind: 'approval',
          status: 'pending',
          requestId: 'appr-9',
          turnId: 'turn-1',
          metadata: { hermesRunId: 'run-appr' },
        },
      },
    })
  })
})
