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
})
