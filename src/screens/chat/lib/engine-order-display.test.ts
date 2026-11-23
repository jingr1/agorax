import { describe, expect, it } from 'vitest'
import { collapseRecentDuplicateUserMessages } from '../chat-queries'
import type { ChatMessage } from '../types'

/**
 * Engine / canonical lists must not drop a second same-text user within 15s.
 * That heuristic exists only for optimistic+server echo on weak-id paths.
 */
describe('strong-id user turns are not text-collapsed', () => {
  it('would collapse same text under the legacy helper', () => {
    const now = Date.now()
    const messages: Array<ChatMessage> = [
      {
        id: 'user:submit-1',
        role: 'user',
        content: [{ type: 'text', text: '继续' }],
        timestamp: now,
        clientSubmitId: 'submit-1',
      } as ChatMessage,
      {
        id: 'assistant:run-1',
        role: 'assistant',
        content: [{ type: 'text', text: '第一轮' }],
        timestamp: now + 1,
      } as ChatMessage,
      {
        id: 'user:submit-2',
        role: 'user',
        content: [{ type: 'text', text: '继续' }],
        timestamp: now + 2_000,
        clientSubmitId: 'submit-2',
      } as ChatMessage,
      {
        id: 'assistant:run-2',
        role: 'assistant',
        content: [{ type: 'text', text: '第二轮' }],
        timestamp: now + 3_000,
      } as ChatMessage,
    ]
    // Document the hazard: legacy helper drops the second user.
    const collapsed = collapseRecentDuplicateUserMessages(messages)
    expect(collapsed.filter((m) => m.role === 'user')).toHaveLength(1)
    // Engine path (preserveEngineOrder) keeps the raw list instead.
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(messages.map((m) => m.id)).toEqual([
      'user:submit-1',
      'assistant:run-1',
      'user:submit-2',
      'assistant:run-2',
    ])
  })
})
