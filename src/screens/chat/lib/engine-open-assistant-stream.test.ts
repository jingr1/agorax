import { describe, expect, it } from 'vitest'
import { applyOpenAssistantStreamingChrome } from './engine-open-assistant-stream'
import type { ChatMessage } from '../types'

function msg(
  id: string,
  role: 'user' | 'assistant',
  extras: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    messageId: id,
    role,
    content:
      role === 'user'
        ? [{ type: 'text', text: 'hi' }]
        : [{ type: 'text', text: 'ok' }],
    timestamp: 1,
    ...extras,
  }
}

describe('applyOpenAssistantStreamingChrome', () => {
  it('binds streamingMessageId to durable assistant after user', () => {
    const chrome = applyOpenAssistantStreamingChrome({
      messages: [
        msg('user:c1', 'user'),
        msg('assistant:run-1', 'assistant', {
          __streamingStatus: 'streaming',
          content: [],
        }),
      ],
      activityStreamingId: null,
      turnActive: true,
      submitting: false,
    })
    expect(chrome.streamingMessageId).toBe('assistant:run-1')
    expect(chrome.turnBusy).toBe(true)
  })

  it('leaves streamingMessageId null when busy with user only', () => {
    const chrome = applyOpenAssistantStreamingChrome({
      messages: [msg('user:c1', 'user')],
      activityStreamingId: null,
      turnActive: true,
      submitting: false,
    })
    expect(chrome.turnBusy).toBe(true)
    expect(chrome.streamingMessageId).toBeNull()
    expect(chrome.messages.map((m) => m.messageId ?? m.id)).toEqual([
      'user:c1',
    ])
  })

  it('is null when turn is closed', () => {
    const chrome = applyOpenAssistantStreamingChrome({
      messages: [
        msg('user:1', 'user'),
        msg('assistant:run-1', 'assistant', {
          __streamingStatus: 'streaming',
          content: [],
        }),
      ],
      activityStreamingId: 'assistant:run-1',
      turnActive: false,
      submitting: false,
    })
    expect(chrome.turnBusy).toBe(false)
    expect(chrome.streamingMessageId).toBeNull()
  })

  it('uses activityStreamingId when turn open and list has no assistant host', () => {
    const chrome = applyOpenAssistantStreamingChrome({
      messages: [msg('user:c1', 'user')],
      activityStreamingId: 'assistant:run-1',
      turnActive: true,
      submitting: false,
    })
    expect(chrome.streamingMessageId).toBe('assistant:run-1')
  })

  it('queued follow-up does not relocate the prior live reply under the new user', () => {
    // Enter-while-busy: prior turn still streaming, new user already appended.
    const chrome = applyOpenAssistantStreamingChrome({
      messages: [
        msg('user:1', 'user', {
          content: [{ type: 'text', text: '旧问题' }],
        }),
        msg('assistant:run-live', 'assistant', {
          __streamingStatus: 'streaming',
          content: [{ type: 'text', text: '旧回复还在生成' }],
        }),
        msg('user:2', 'user', {
          content: [{ type: 'text', text: 'setcap 跑完了' }],
        }),
      ],
      activityStreamingId: 'assistant:run-live',
      turnActive: true,
      submitting: true,
    })
    expect(chrome.turnBusy).toBe(true)
    expect(chrome.streamingMessageId).toBeNull()
    expect(chrome.messages.map((m) => m.messageId ?? m.id)).toEqual([
      'user:1',
      'assistant:run-live',
      'user:2',
    ])
    expect(textFrom(chrome.messages[1]!)).toBe('旧回复还在生成')
  })
})

function textFrom(message: ChatMessage): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part) =>
      part && typeof part === 'object' && part.type === 'text'
        ? String(part.text ?? '')
        : '',
    )
    .join('')
}
