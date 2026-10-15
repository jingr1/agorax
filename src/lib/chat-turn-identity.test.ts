import { describe, expect, it } from 'vitest'
import {
  assistantMessageIdForRun,
  foldOpenTurnIntoLiveHost,
  preferLiveAssistantOnCollision,
  projectLiveAssistantMessage,
  readDurableMessageId,
  stableChatMessageKey,
  upsertMessageByDurableId,
} from './chat-turn-identity'

describe('assistantMessageIdForRun', () => {
  it('uses runId when present', () => {
    expect(assistantMessageIdForRun('run-abc', 'sess')).toBe('assistant:run-abc')
  })

  it('requires turnKey when runId is missing', () => {
    expect(() => assistantMessageIdForRun(null, 'sess-1')).toThrow(/turnKey/)
  })

  it('scopes pending ids by turn so turns do not collide', () => {
    expect(assistantMessageIdForRun(null, 'sess-1', 'turn-a')).toBe(
      'assistant:pending:sess-1:turn-a',
    )
    expect(assistantMessageIdForRun(null, 'sess-1', 'turn-b')).not.toBe(
      assistantMessageIdForRun(null, 'sess-1', 'turn-a'),
    )
  })
})

describe('upsertMessageByDurableId', () => {
  it('replaces the same durable row instead of appending', () => {
    const first = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: 'Hi',
      thinking: 'plan',
      toolCalls: [],
      streaming: true,
      timestamp: 1,
    })
    const second = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: 'Hi there',
      thinking: 'plan',
      toolCalls: [{ id: 't1', name: 'read_file', phase: 'complete' }],
      streaming: false,
      timestamp: 2,
    })
    type Row = ReturnType<typeof projectLiveAssistantMessage>
    const messages = upsertMessageByDurableId<Row>(
      upsertMessageByDurableId<Row>([], first),
      second,
    )
    expect(messages).toHaveLength(1)
    expect(readDurableMessageId(messages[0]!)).toBe('assistant:r1')
    expect(messages[0]!.__streamingStatus).toBe('complete')
    expect(messages[0]!.__streamToolCalls).toHaveLength(1)
  })

  it('anchors a live row after the latest user when requested', () => {
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:pending:s:t1',
      runId: null,
      text: 'reply',
      thinking: '',
      toolCalls: [],
      streaming: true,
      timestamp: 1,
    })
    type Row = {
      role: string
      id?: string
      messageId?: string
      content?: unknown
    }
    const messages = upsertMessageByDurableId<Row>(
      [
        { role: 'user', id: 'u0', content: [{ type: 'text', text: 'old' }] },
        live as unknown as Row,
        { role: 'user', id: 'u1', content: [{ type: 'text', text: 'new' }] },
      ],
      live as unknown as Row,
      { anchorAfterLastUser: true },
    )
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(readDurableMessageId(messages[2]!)).toBe('assistant:pending:s:t1')
  })
})

describe('stableChatMessageKey', () => {
  it('prefers durable messageId over text fingerprint', () => {
    const key = stableChatMessageKey(
      {
        messageId: 'assistant:r1',
        role: 'assistant',
        content: [{ type: 'text', text: 'growing text' }],
      },
      0,
      () => 'growing text',
    )
    expect(key).toBe('assistant:r1')
  })
})

describe('foldOpenTurnIntoLiveHost', () => {
  it('keeps folding after settle so mid-turn orphans do not reappear', () => {
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: '结论',
      thinking: '',
      toolCalls: [],
      streaming: false,
      timestamp: 2,
    })
    const folded = foldOpenTurnIntoLiveHost(
      [
        {
          role: 'user',
          id: 'u1',
          content: [{ type: 'text', text: '问' }],
        },
        {
          role: 'assistant',
          id: 'orphan-tool',
          content: [
            { type: 'toolCall', id: 't1', name: 'explore', arguments: {} },
          ],
        },
        live,
      ],
      {
        liveMessageId: 'assistant:r1',
        isStreaming: false,
        streamingText: '结论',
        runId: 'r1',
      },
    )

    expect(folded).toHaveLength(2)
    expect(folded[0]!.role).toBe('user')
    expect(readDurableMessageId(folded[1]!)).toBe('assistant:r1')
    expect(folded[1]!.__streamingStatus).toBe('complete')
  })

  it('relocates a live host that landed before the latest user prompt', () => {
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:pending:s:t1',
      runId: null,
      text: '先出现在上面',
      thinking: '',
      toolCalls: [],
      streaming: true,
      timestamp: 1,
    })
    const folded = foldOpenTurnIntoLiveHost(
      [
        {
          role: 'user',
          id: 'u0',
          content: [{ type: 'text', text: '旧问题' }],
        },
        live,
        {
          role: 'user',
          id: 'u1',
          content: [{ type: 'text', text: '新问题' }],
        },
      ],
      {
        liveMessageId: 'assistant:pending:s:t1',
        isStreaming: true,
        streamingText: '先出现在上面',
        runId: null,
      },
    )

    expect(folded.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(readDurableMessageId(folded[2]!)).toBe('assistant:pending:s:t1')
    expect(folded.filter((m) => readDurableMessageId(m) === 'assistant:pending:s:t1')).toHaveLength(
      1,
    )
  })

  it('collapses mid-turn text + tool-only orphans into one streaming host', () => {
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: '分析结论',
      thinking: '',
      toolCalls: [{ id: 't2', name: 'read_file', phase: 'complete' }],
      streaming: true,
      timestamp: 3,
    })
    const folded = foldOpenTurnIntoLiveHost(
      [
        {
          role: 'user',
          id: 'u1',
          content: [{ type: 'text', text: 'fix' }],
        },
        {
          role: 'assistant',
          id: 'orphan-tool',
          content: [
            { type: 'toolCall', id: 't1', name: 'explore', arguments: {} },
          ],
        },
        {
          role: 'assistant',
          id: 'hist-text',
          content: [{ type: 'text', text: '分析结论' }],
        },
        live,
      ],
      {
        liveMessageId: 'assistant:r1',
        isStreaming: true,
        streamingText: '分析结论',
        toolCalls: [{ id: 't2', name: 'read_file', phase: 'complete' }],
        runId: 'r1',
      },
    )

    expect(folded).toHaveLength(2)
    expect(folded[0]!.role).toBe('user')
    expect(readDurableMessageId(folded[1]!)).toBe('assistant:r1')
    expect(folded[1]!.__streamingStatus).toBe('streaming')
    expect(folded[1]!.__streamToolCalls?.map((t) => t.id).sort()).toEqual([
      't1',
      't2',
    ])
  })
})

describe('preferLiveAssistantOnCollision', () => {
  it('keeps the streaming durable row over a settled history echo', () => {
    const history = {
      role: 'assistant' as const,
      id: 'msg-hist',
      content: [{ type: 'text', text: 'same' }],
    }
    const live = projectLiveAssistantMessage({
      messageId: 'assistant:r1',
      runId: 'r1',
      text: 'same',
      thinking: '',
      toolCalls: [],
      streaming: true,
      timestamp: 1,
    })
    expect(
      preferLiveAssistantOnCollision(history, live, 'assistant:r1'),
    ).toBe(live)
  })
})
