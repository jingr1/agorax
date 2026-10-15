import { describe, expect, it } from 'vitest'
import {
  assistantHasVisibleHostContent,
  assistantHasWorkingSurface,
  mergeAssistantThinkingFromSource,
  mergeStreamToolCallRecords,
  normalizeChatContentParts,
  normalizeToolCallArgs,
  thinkingTextFromMessage,
  parseStoredMessageContent,
  splitCompleteThinkingTags,
  storedMessageContentToText,
  thinkingContentFromText,
  thinkingTextFromContent,
  thinkingTextFromPayload,
} from './chat-message-parts'

describe('parseStoredMessageContent', () => {
  it('keeps structured thinking blocks instead of flattening to text', () => {
    const raw = JSON.stringify([
      { type: 'thinking', thinking: 'Plan first.' },
      { type: 'text', text: 'Done.' },
    ])
    expect(parseStoredMessageContent(raw)).toEqual([
      { type: 'thinking', thinking: 'Plan first.' },
      { type: 'text', text: 'Done.' },
    ])
  })

  it('returns plain strings unchanged', () => {
    expect(parseStoredMessageContent('hello')).toBe('hello')
  })
})

describe('normalizeChatContentParts', () => {
  it('maps Hermes history blocks to the same thinking part shape as managed ACP', () => {
    expect(
      normalizeChatContentParts(
        [
          { type: 'thinking', thinking: 'Check the files.' },
          { type: 'text', text: 'Here they are.' },
        ],
        { role: 'assistant' },
      ),
    ).toEqual([
      { type: 'thinking', thinking: 'Check the files.' },
      { type: 'text', text: 'Here they are.' },
    ])
  })

  it('maps OpenAI-style reasoning blocks into thinking for Activity', () => {
    expect(
      normalizeChatContentParts(
        [
          { type: 'reasoning', text: 'Inspect first.' },
          { type: 'text', text: 'OK.' },
        ],
        { role: 'assistant' },
      ),
    ).toEqual([
      { type: 'thinking', thinking: 'Inspect first.' },
      { type: 'text', text: 'OK.' },
    ])
  })

  it('splits inline think tags from plain assistant text', () => {
    expect(
      normalizeChatContentParts(
        '<think>reason</think>\nVisible answer',
        { role: 'assistant' },
      ),
    ).toEqual([
      { type: 'thinking', thinking: 'reason' },
      { type: 'text', text: 'Visible answer' },
    ])
  })

  it('does not extract think tags from user content', () => {
    expect(
      normalizeChatContentParts('<think>secret</think>hi', { role: 'user' }),
    ).toEqual([{ type: 'text', text: '<think>secret</think>hi' }])
  })
})

describe('storedMessageContentToText', () => {
  it('omits thinking blocks from plain-text previews', () => {
    expect(
      storedMessageContentToText(
        JSON.stringify([
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'visible' },
        ]),
      ),
    ).toBe('visible')
  })
})

describe('thinking helpers', () => {
  it('builds thinking parts from managed reasoning payloads', () => {
    expect(thinkingTextFromPayload({ text: '  hello  ' })).toBe('hello')
    expect(thinkingContentFromText('  hello  ')).toEqual({
      type: 'thinking',
      thinking: 'hello',
    })
    expect(thinkingContentFromText('   ')).toBeNull()
  })

  it('reads thinking from mixed content arrays', () => {
    expect(
      thinkingTextFromContent([
        { type: 'thinking', thinking: 'a' },
        { type: 'text', text: 'b' },
        { type: 'thinking', thinking: 'c' },
      ]),
    ).toBe('a\n\nc')
  })
})

describe('assistantHasVisibleHostContent', () => {
  it('treats thinking-only rows as visible like managed ACP', () => {
    expect(
      assistantHasVisibleHostContent({
        content: [{ type: 'thinking', thinking: 'planning' }],
      }),
    ).toBe(true)
  })

  it('rejects empty assistant rows', () => {
    expect(assistantHasVisibleHostContent({ content: [] })).toBe(false)
    expect(
      assistantHasVisibleHostContent({
        content: [{ type: 'text', text: '   ' }],
      }),
    ).toBe(false)
  })

  it('keeps empty streaming host so Working can anchor above the live row', () => {
    expect(
      assistantHasVisibleHostContent({
        content: [],
        __streamingStatus: 'streaming',
      }),
    ).toBe(true)
  })

  it('keeps streaming rows that only have sidecar thinking', () => {
    expect(
      assistantHasVisibleHostContent({
        content: [],
        __streamingStatus: 'streaming',
        __streamingThinking: 'planning the next step',
      }),
    ).toBe(true)
  })

  it('keeps streaming rows once tool calls are attached', () => {
    expect(
      assistantHasVisibleHostContent({
        content: [],
        __streamingStatus: 'streaming',
        __streamToolCalls: [{ id: 't1', name: 'Read' }],
      }),
    ).toBe(true)
  })
})

describe('assistantHasWorkingSurface', () => {
  it('ignores plain reply text', () => {
    expect(
      assistantHasWorkingSurface({
        content: [{ type: 'text', text: 'On it.' }],
      }),
    ).toBe(false)
  })

  it('is true for thinking or tool calls', () => {
    expect(
      assistantHasWorkingSurface({
        content: [{ type: 'thinking', thinking: 'planning' }],
      }),
    ).toBe(true)
    expect(
      assistantHasWorkingSurface({
        content: [],
        __streamToolCalls: [{ id: 't1', name: 'Read' }],
      }),
    ).toBe(true)
  })
})

describe('splitCompleteThinkingTags', () => {
  it('extracts complete tags only', () => {
    expect(splitCompleteThinkingTags('<thinking>x</thinking>y')).toEqual({
      text: 'y',
      thinking: 'x',
    })
  })
})

describe('mergeAssistantThinkingFromSource', () => {
  it('keeps realtime thinking when history refetch returns text-only', () => {
    const history = {
      role: 'assistant',
      content: [{ type: 'text' as const, text: 'Done.' }],
    }
    const realtime = {
      role: 'assistant',
      content: [
        { type: 'thinking' as const, thinking: 'Plan first.' },
        { type: 'text' as const, text: 'Done.' },
      ],
    }
    expect(mergeAssistantThinkingFromSource(history, realtime)).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Plan first.' },
        { type: 'text', text: 'Done.' },
      ],
    })
  })

  it('folds streamingThinking overlay onto a server assistant row', () => {
    const server = {
      role: 'assistant',
      content: [{ type: 'text' as const, text: 'partial' }],
    }
    expect(
      mergeAssistantThinkingFromSource(server, {
        role: 'assistant',
        __streamingThinking: 'still reasoning',
      }),
    ).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'still reasoning' },
        { type: 'text', text: 'partial' },
      ],
    })
  })

  it('normalizeToolCallArgs parses JSON string arguments', () => {
    expect(normalizeToolCallArgs('{"path":"/tmp/a.md"}')).toEqual({
      path: '/tmp/a.md',
    })
  })

  it('mergeStreamToolCallRecords keeps tool name/args from the write-through row', () => {
    expect(
      mergeStreamToolCallRecords(
        [{ id: 't1', name: 'tool', phase: 'complete', args: undefined }],
        [
          {
            id: 't1',
            name: 'read_file',
            phase: 'calling',
            args: '{"path":"README.md"}',
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        id: 't1',
        name: 'read_file',
        args: { path: 'README.md' },
      }),
    ])
  })

  it('thinkingTextFromMessage prefers the longer durable field', () => {
    expect(
      thinkingTextFromMessage({
        content: [{ type: 'thinking', thinking: 'from content' }],
        __streamingThinking: 'from content with more detail',
      }),
    ).toBe('from content with more detail')
  })

  it('does not shrink an existing longer thinking trace', () => {
    const history = {
      role: 'assistant',
      content: [
        { type: 'thinking' as const, thinking: 'long detailed plan' },
        { type: 'text' as const, text: 'ok' },
      ],
    }
    expect(
      mergeAssistantThinkingFromSource(history, {
        role: 'assistant',
        content: [{ type: 'thinking' as const, thinking: 'short' }],
      }),
    ).toBe(history)
  })
})
