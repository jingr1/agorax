import { describe, expect, it } from 'vitest'
import {
  buildDisplayEntries,
  getTrailingToolOnlyTurnSummary,
  openTurnProcessingHasReplySurface,
  sortMessagesChronologically,
  streamingMessageHasVisibleContent,
} from './chat-message-list'
import { getMessageTimestamp } from '../utils'
import type { ChatMessage } from '../types'

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): ChatMessage {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
    timestamp: 1,
  } as ChatMessage
}

function toolOnlyAssistant(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: `${id}-tool`,
        name: 'terminal',
        arguments: {},
      },
    ],
    timestamp: 2,
  } as ChatMessage
}

describe('sortMessagesChronologically', () => {
  it('keeps U-A interleaving when timestamps collide (no UUUAAA clustering)', () => {
    const messages = [
      textMessage('u1', 'user', '你好'),
      textMessage('a1', 'assistant', '你好！有什么我可以帮你的吗？'),
      textMessage('u2', 'user', '你是谁？'),
      textMessage('a2', 'assistant', '我是 Architect Agent'),
      textMessage('u3', 'user', '你在干什么？'),
      textMessage('a3', 'assistant', '我目前没在跑任何具体任务。'),
    ]
    const sorted = sortMessagesChronologically(messages)
    expect(sorted.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
      'a3',
    ])
  })
})

describe('getMessageTimestamp', () => {
  it('uses 0 for missing timestamps so equal-time sorts stay stable', () => {
    expect(
      getMessageTimestamp({
        id: 'x',
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      } as ChatMessage),
    ).toBe(0)
  })
})

describe('buildDisplayEntries', () => {
  it('does not attach trailing persisted tool-only assistant messages to the last text reply', () => {
    const entries = buildDisplayEntries([
      textMessage('u1', 'user', 'show issues'),
      textMessage('a1', 'assistant', 'Open issues: 2'),
      toolOnlyAssistant('a2'),
      toolOnlyAssistant('a3'),
    ])

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'a1'])
    expect(entries[1].attachedToolMessages).toHaveLength(0)
  })

  it('attaches managed tool_call messages to the following assistant text entry', () => {
    const managedToolCall = {
      id: 'tool-1',
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'msg-tool-1',
          name: 'bash',
          arguments: { command: 'ls' },
        },
      ],
      timestamp: 2,
      toolName: 'bash',
      details: { input: { command: 'ls' }, output: 'README.md' },
    } as unknown as ChatMessage
    const reasoning = {
      id: 'r1',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me list the files.' }],
      timestamp: 1,
    } as unknown as ChatMessage

    const entries = buildDisplayEntries([
      textMessage('u1', 'user', 'list files'),
      reasoning,
      managedToolCall,
      textMessage('a1', 'assistant', 'Here you go.'),
    ])

    // List-layer attach is a legacy safety net for pre-fold rows. Engine
    // projection (projectActivityMessagesToChat) folds reasoning+tools+text
    // into one host before the list; when unfolder rows still arrive, tools
    // attach to the next text reply and reasoning stays its own entry.
    expect(entries.map((entry) => entry.message.id)).toEqual(['u1', 'r1', 'a1'])
    expect(entries[2].attachedToolMessages).toHaveLength(1)
    expect(entries[2].attachedToolMessages[0]).toMatchObject({
      toolName: 'bash',
      details: { input: { command: 'ls' }, output: 'README.md' },
    })
  })
})

describe('streamingMessageHasVisibleContent', () => {
  it('treats managed thinking-only rows as visible without Hermes streaming props', () => {
    const reasoning = {
      id: 'r1',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'User greeted me.' }],
      timestamp: 1,
    } as unknown as ChatMessage

    expect(streamingMessageHasVisibleContent(reasoning)).toBe(true)
    expect(
      streamingMessageHasVisibleContent(textMessage('a1', 'assistant', '')),
    ).toBe(false)
    expect(
      streamingMessageHasVisibleContent(textMessage('a1', 'assistant', ''), {
        streamingText: '你好',
      }),
    ).toBe(true)
  })

  it('keeps a Working row visible when only sidecar thinking or tools remain', () => {
    expect(
      streamingMessageHasVisibleContent({
        id: 'a-think',
        role: 'assistant',
        content: [],
        __streamingThinking: 'planning',
        timestamp: 1,
      } as unknown as ChatMessage),
    ).toBe(true)
    expect(
      streamingMessageHasVisibleContent({
        id: 'a-tool',
        role: 'assistant',
        content: [],
        __streamToolCalls: [{ id: 't1', name: 'Read' }],
        timestamp: 1,
      } as unknown as ChatMessage),
    ).toBe(true)
  })

  it('treats managed assistant text on the message row as visible', () => {
    expect(
      streamingMessageHasVisibleContent(
        textMessage('a1', 'assistant', '你好！有什么我可以帮你的吗？'),
      ),
    ).toBe(true)
  })

  it('replyBodyOnly ignores thinking/tools so MessageItem stays hidden until reply text', () => {
    expect(
      streamingMessageHasVisibleContent(textMessage('a1', 'assistant', ''), {
        streamingThinking: 'planning',
        hasToolActivity: true,
        replyBodyOnly: true,
      }),
    ).toBe(false)
    expect(
      streamingMessageHasVisibleContent(textMessage('a1', 'assistant', ''), {
        streamingText: '你好',
        replyBodyOnly: true,
      }),
    ).toBe(true)
  })

  it('replyBodyOnly treats __streamingText as reply body (matches MessageItem)', () => {
    expect(
      streamingMessageHasVisibleContent(
        {
          id: 'a1',
          role: 'assistant',
          content: [],
          __streamingText: '你好',
          __streamingStatus: 'streaming',
          timestamp: 1,
        } as unknown as ChatMessage,
        { replyBodyOnly: true },
      ),
    ).toBe(true)
  })
})

describe('openTurnProcessingHasReplySurface', () => {
  it('clears live Thinking…/glow when Hermes reply is only on __streamingText', () => {
    expect(
      openTurnProcessingHasReplySurface({
        id: 'assistant:run-1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'planning the greeting' }],
        __streamingText: '你好！这次想让我做什么？',
        __streamingStatus: 'streaming',
        timestamp: 1,
      } as unknown as ChatMessage),
    ).toBe(true)
  })

  it('keeps live Thinking…/glow while only thinking/tools exist (no reply body)', () => {
    expect(
      openTurnProcessingHasReplySurface({
        id: 'assistant:run-1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'planning the greeting' }],
        __streamingStatus: 'streaming',
        timestamp: 1,
      } as unknown as ChatMessage),
    ).toBe(false)
    expect(
      openTurnProcessingHasReplySurface({
        id: 'assistant:run-1',
        role: 'assistant',
        content: [],
        __streamToolCalls: [{ id: 't1', name: 'Read' }],
        __streamingStatus: 'streaming',
        timestamp: 1,
      } as unknown as ChatMessage),
    ).toBe(false)
  })
})

describe('getTrailingToolOnlyTurnSummary', () => {
  it('detects hidden trailing tool-only messages after the final assistant response', () => {
    const summary = getTrailingToolOnlyTurnSummary([
      textMessage('u1', 'user', 'show issues'),
      textMessage('a1', 'assistant', 'Open issues: 2'),
      toolOnlyAssistant('a2'),
      {
        id: 't1',
        role: 'toolResult',
        toolCallId: 'a2-tool',
        toolName: 'terminal',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 3,
      } as ChatMessage,
      toolOnlyAssistant('a3'),
    ])

    expect(summary).toEqual({
      count: 3,
      toolNames: ['terminal'],
      hasFinalAssistantText: true,
    })
  })

  it('returns null when the thread already ends with assistant text', () => {
    const summary = getTrailingToolOnlyTurnSummary([
      textMessage('u1', 'user', 'show issues'),
      toolOnlyAssistant('a2'),
      textMessage('a1', 'assistant', 'Done.'),
    ])

    expect(summary).toBeNull()
  })
})
