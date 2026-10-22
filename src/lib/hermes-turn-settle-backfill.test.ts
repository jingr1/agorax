import { describe, expect, it } from 'vitest'
import {
  assistantPlainTextFromHistoryMessage,
  baselineAfterLastUserMessage,
  baselineAfterOpenTurnUser,
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

  it('does not stamp a prior turn when the latest turn is still empty', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '你好！有什么需要我帮忙的？' }],
      },
      { role: 'user', content: [{ type: 'text', text: '现在用的是哪个模型' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [] },
    ]
    const baseline = baselineAfterLastUserMessage(messages)
    expect(baseline).toBe(3)
    expect(pickAuthoritativeAssistantText(messages, baseline)).toBe('')
  })

  it('stamps only when live empty or auth completes the same stream', () => {
    expect(shouldStampAssistantText('', 'hello')).toBe(true)
    expect(shouldStampAssistantText('hello', 'hello world')).toBe(true)
    expect(shouldStampAssistantText('hello world', 'hi')).toBe(false)
    expect(shouldStampAssistantText('same', 'same')).toBe(false)
    // Longer unrelated prior turn must NOT overwrite a short new reply.
    expect(
      shouldStampAssistantText(
        '这次生效了。现在跑的是 DeepSeek-V4-Flash',
        '很长的上一条回复……要我继续钉死吗？',
      ),
    ).toBe(false)
  })

  it('skips stamp when open-turn user is not in history yet', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '很长的上一条回复' }],
      },
    ]
    expect(
      baselineAfterOpenTurnUser(messages, {
        clientSubmitId: 'c-new',
        userText: '现在是哪个模型',
      }),
    ).toBeNull()
  })

  it('baselines after Workspace-prefixed open user in history', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '旧回复' }],
      },
      {
        role: 'user',
        clientId: 'c-new',
        content: [
          {
            type: 'text',
            text: '[Workspace::v1: /tmp/proj]\n现在是哪个模型',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '现在是 Flash' }],
      },
    ]
    const baseline = baselineAfterOpenTurnUser(messages, {
      clientSubmitId: 'c-new',
      userText: '现在是哪个模型',
    })
    expect(baseline).toBe(3)
    expect(pickAuthoritativeAssistantText(messages, baseline ?? 0)).toBe(
      '现在是 Flash',
    )
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
