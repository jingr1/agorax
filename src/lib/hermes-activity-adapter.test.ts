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

  it('keeps pre-seeded pending host across started→runId (no second row)', () => {
    const pendingId = 'assistant:pending:sess-1:c-seed'
    let state = {
      ...createHermesActivityAdapterState(),
      assistantMessageId: pendingId,
      thinkingMessageId: `${pendingId}:thinking`,
    }
    const started = hermesSseToActivityEvents(ctx, state, 'started', {
      runId: 'run-seed',
    })
    state = started.state
    expect(state.assistantMessageId).toBe(pendingId)
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'message_delta',
          data: expect.objectContaining({
            messageId: pendingId,
            content: { operation: 'set', value: '' },
          }),
        }),
      ]),
    )
    const chunk = hermesSseToActivityEvents(ctx, state, 'chunk', {
      runId: 'run-seed',
      text: 'Answer',
      fullReplace: true,
    })
    expect(chunk.events[0]).toMatchObject({
      data: { messageId: pendingId, content: { operation: 'set', value: 'Answer' } },
    })
    expect(chunk.events.every((e) => {
      if (e.eventType !== 'message_delta') return true
      const id = (e.data as { messageId?: string }).messageId ?? ''
      return !id.startsWith('assistant:run-')
    })).toBe(true)
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
    expect(done.events[0]).toMatchObject({
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
    expect(failed.events[0]).toMatchObject({
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
    expect(interrupted.events[0]).toMatchObject({
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
