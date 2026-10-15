import { describe, expect, it } from 'vitest'
import { toChatMessage } from './hermes-api'

describe('toChatMessage thinking normalization', () => {
  it('preserves structured thinking blocks from profile history', () => {
    const msg = toChatMessage({
      id: 1,
      session_id: 'sess-1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Inspect the repo.' },
        { type: 'text', text: 'All good.' },
      ],
      timestamp: 1700000000,
    })

    expect(msg.content).toEqual([
      { type: 'thinking', thinking: 'Inspect the repo.' },
      { type: 'text', text: 'All good.' },
    ])
    expect(msg.text).toBe('All good.')
  })

  it('splits inline think tags from plain-text assistant content', () => {
    const msg = toChatMessage({
      id: 2,
      session_id: 'sess-1',
      role: 'assistant',
      content: '<think>step one</think>\nReply body',
      timestamp: 1700000000,
    })

    expect(msg.content).toEqual([
      { type: 'thinking', thinking: 'step one' },
      { type: 'text', text: 'Reply body' },
    ])
  })

  it('keeps user content as plain text without think extraction', () => {
    const msg = toChatMessage({
      id: 3,
      session_id: 'sess-1',
      role: 'user',
      content: '<think>not thinking</think>hi',
      timestamp: 1700000000,
    })

    expect(msg.content).toEqual([
      { type: 'text', text: '<think>not thinking</think>hi' },
    ])
  })
})
