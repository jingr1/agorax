import { describe, expect, it } from 'vitest'
import {
  foldTrailingAssistantThinking,
  messagePlainText,
  reconcileHistoryMessages,
  reconcileHistoryResponse,
  textsLooselyMatch,
} from './chat-history-reconcile'

describe('messagePlainText', () => {
  it('reads text parts instead of Array#toString', () => {
    expect(
      messagePlainText({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'Final answer from a long stream.' },
        ],
      }),
    ).toBe('Final answer from a long stream.')
  })
})

describe('textsLooselyMatch', () => {
  it('matches streaming prefix against final history text', () => {
    expect(
      textsLooselyMatch(
        'Here is the beginning',
        'Here is the beginning and the rest of a long answer.',
      ),
    ).toBe(true)
  })
})

describe('reconcileHistoryMessages', () => {
  it('reuses previous object identity when server echo matches text', () => {
    const previousAssistant = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'Done.' },
      ],
    }
    const previous = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      previousAssistant,
    ]
    const incoming = [
      { role: 'user', id: 'msg-1', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        id: 'msg-2',
        content: [{ type: 'text', text: 'Done.' }],
      },
    ]

    const reconciled = reconcileHistoryMessages(previous, incoming)
    expect(reconciled[1]).toBe(previousAssistant)
    expect(reconciled[1]).toMatchObject({
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'Done.' },
      ],
    })
  })

  it('keeps live thinking and printed text when history returns tools + rewrite', () => {
    const streamText =
      'I inspected the repo and applied the fix across several files carefully.'
    const previous = [
      { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to read then patch.' },
          { type: 'text', text: streamText },
        ],
        __streamToolCalls: [{ id: 't1', name: 'read_file', phase: 'complete' }],
      },
    ]
    const incoming = [
      {
        role: 'user',
        id: 'u1',
        content: [{ type: 'text', text: 'fix it' }],
      },
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'toolCall',
            id: 't1',
            name: 'read_file',
          },
          {
            type: 'toolCall',
            id: 't2',
            name: 'write_file',
          },
          // Server echo often rephrases — must not replace what the user read.
          {
            type: 'text',
            text: `${streamText} (persisted rewrite)`,
          },
        ],
      },
    ]

    const reconciled = reconcileHistoryMessages(previous, incoming)
    const assistant = reconciled[1] as {
      id?: string
      content: Array<{ type: string; thinking?: string; text?: string }>
    }
    expect(
      assistant.content.find((part) => part.type === 'thinking')?.thinking,
    ).toBe('Need to read then patch.')
    expect(assistant.content.find((part) => part.type === 'text')?.text).toBe(
      streamText,
    )
    expect(
      assistant.content.filter((part) => part.type === 'toolCall'),
    ).toHaveLength(2)
    expect(assistant.id).toBe('a1')
  })

  it('keeps optimistic rows the server has not echoed', () => {
    const optimistic = {
      role: 'user',
      __optimisticId: 'opt-1',
      status: 'sending',
      content: [{ type: 'text', text: 'hello' }],
    }
    const previous = [optimistic]
    const incoming = [
      {
        role: 'assistant',
        id: 'msg-9',
        content: [{ type: 'text', text: 'hi' }],
      },
    ]

    const reconciled = reconcileHistoryMessages(previous, incoming)
    expect(reconciled).toHaveLength(2)
    expect(reconciled[1]).toBe(optimistic)
  })
})

describe('foldTrailingAssistantThinking', () => {
  it('folds streaming thinking onto the last assistant when match failed', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'read_file' },
          { type: 'text', text: 'All done.' },
        ],
      },
    ]
    const folded = foldTrailingAssistantThinking(messages, {
      role: 'assistant',
      __streamingThinking: 'I should call read_file first.',
    })
    expect(
      (
        folded[1] as {
          content: Array<{ type: string; thinking?: string }>
        }
      ).content[0],
    ).toEqual({
      type: 'thinking',
      thinking: 'I should call read_file first.',
    })
  })
})

describe('reconcileHistoryResponse', () => {
  it('returns the previous root when messages are identity-stable', () => {
    const assistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    }
    const previous = {
      sessionKey: 's1',
      messages: [assistant],
    }
    const incoming = {
      sessionKey: 's1',
      messages: [
        {
          role: 'assistant',
          id: 'msg-1',
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
    }

    const next = reconcileHistoryResponse(previous, incoming)
    expect(next).toBe(previous)
  })
})
