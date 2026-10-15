import { describe, expect, it } from 'vitest'
import {
  assistantPlainTextFromHistoryMessage,
  hermesAssistantTextStampDelta,
  hermesSettledTurnUpdate,
  pickAuthoritativeAssistantText,
  shouldFetchHistoryForSettle,
  shouldStampAssistantText,
} from './hermes-turn-settle-backfill'

describe('hermes-turn-settle-backfill', () => {
  it('picks the last assistant text after baseline', () => {
    const text = pickAuthoritativeAssistantText(
      [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'short' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer body' }],
        },
      ],
      0,
    )
    expect(text).toBe('final answer body')
  })

  it('stamps only when authoritative text is longer or live empty', () => {
    expect(shouldStampAssistantText('', 'hello')).toBe(true)
    expect(shouldStampAssistantText('hi', 'hello world')).toBe(true)
    expect(shouldStampAssistantText('hello world', 'hi')).toBe(false)
    expect(shouldStampAssistantText('same', 'same')).toBe(false)
  })

  it('skips history fetch when done.message already stamped final text', () => {
    expect(
      shouldFetchHistoryForSettle({
        doneCarriedFinalText: true,
        liveText: 'final answer',
      }),
    ).toBe(false)
    expect(
      shouldFetchHistoryForSettle({
        doneCarriedFinalText: true,
        liveText: '',
      }),
    ).toBe(true)
    expect(
      shouldFetchHistoryForSettle({
        doneCarriedFinalText: false,
        liveText: 'partial',
      }),
    ).toBe(true)
  })

  it('reads plain text from content parts', () => {
    expect(
      assistantPlainTextFromHistoryMessage({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: ' body ' },
        ],
      }),
    ).toBe('body')
  })

  it('builds settled turn_update and text stamp deltas', () => {
    const settled = hermesSettledTurnUpdate({
      workspaceId: 'ws',
      agentSessionId: 's1',
      turnId: 't1',
      outcome: 'completed',
      nowUnixMs: 10,
    })
    expect(settled).toMatchObject({
      eventType: 'turn_update',
      data: {
        activeTurnId: null,
        turn: { phase: 'settled', outcome: 'completed', turnId: 't1' },
      },
    })

    const stamp = hermesAssistantTextStampDelta({
      workspaceId: 'ws',
      agentSessionId: 's1',
      turnId: 't1',
      messageId: 'assistant:run-1',
      text: 'final',
      nowUnixMs: 11,
    })
    expect(stamp).toMatchObject({
      eventType: 'message_delta',
      data: {
        messageId: 'assistant:run-1',
        content: { operation: 'set', value: 'final' },
      },
    })
  })
})
