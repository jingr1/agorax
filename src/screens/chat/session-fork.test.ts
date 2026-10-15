import { describe, expect, it } from 'vitest'

import {
  findLastUserMessage,
  historyIndexOf,
  keepCountForEdit,
  keepCountForRegenerate,
} from './session-fork'
import type { ChatMessage } from './types'

describe('edit / regenerate keep counts', () => {
  it('truncates before the edited or regenerated message', () => {
    expect(keepCountForEdit(3)).toBe(3)
    expect(keepCountForRegenerate(5)).toBe(5)
  })
})

describe('findLastUserMessage', () => {
  const messages: Array<ChatMessage> = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      __historyIndex: 0,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      __historyIndex: 1,
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'again' }],
      __historyIndex: 2,
    },
  ]

  it('finds the last user row', () => {
    expect(findLastUserMessage(messages)?.__historyIndex).toBe(2)
    expect(historyIndexOf(messages[0]!)).toBe(0)
  })
})
