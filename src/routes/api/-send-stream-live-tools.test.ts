import { describe, expect, it } from 'vitest'

import {
  collectGatewayPayloadToolEvents,
  collectSyntheticLiveThinkingText,
  collectSyntheticLiveToolEvents,
  createSyntheticLiveToolTracker,
} from './-send-stream-live-tools'
import {
  consumeInlineThinking,
  extractReasoningFromGatewayEvent,
  extractReasoningFromToolProgress,
  extractStreamingThinking,
} from './send-stream'

describe('extractReasoningFromToolProgress', () => {
  it('extracts reasoning from event_type reasoning.available preview', () => {
    expect(
      extractReasoningFromToolProgress({
        event: 'reasoning.available',
        preview: 'I should check the config first',
      }),
    ).toBe('I should check the config first')
  })

  it('extracts reasoning from string tool _thinking name', () => {
    expect(
      extractReasoningFromToolProgress({
        tool: '_thinking',
        name: 'reading the plan',
      }),
    ).toBe('reading the plan')
  })

  it('extracts reasoning from tool object name _thinking', () => {
    expect(
      extractReasoningFromToolProgress({
        tool: { name: '_thinking' },
        delta: 'incremental token',
      }),
    ).toBe('incremental token')
  })

  it('returns null for a regular tool progress', () => {
    expect(
      extractReasoningFromToolProgress({
        tool: 'read_file',
        delta: '{"path":"/tmp/a"}',
      }),
    ).toBeNull()
  })
})

describe('extractReasoningFromGatewayEvent', () => {
  it('extracts reasoning.delta text for Activity thinking', () => {
    expect(
      extractReasoningFromGatewayEvent('reasoning.delta', {
        delta: 'First I will inspect the repo.',
      }),
    ).toBe('First I will inspect the repo.')
  })

  it('extracts response.reasoning_text.delta nested content', () => {
    expect(
      extractReasoningFromGatewayEvent('response.reasoning_text.delta', {
        delta: { text: 'nested reasoning' },
      }),
    ).toBe('nested reasoning')
  })

  it('returns null for unrelated events', () => {
    expect(
      extractReasoningFromGatewayEvent('tool.completed', {
        delta: 'not reasoning',
      }),
    ).toBeNull()
  })
})

describe('collectSyntheticLiveThinkingText', () => {
  it('extracts reasoning blocks from assistant session messages', () => {
    expect(
      collectSyntheticLiveThinkingText([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspect the redeploy sample first.' },
          ],
        },
      ]),
    ).toBe('Inspect the redeploy sample first.')
  })

  it('prefers the longest reasoning trace across assistant rows', () => {
    expect(
      collectSyntheticLiveThinkingText([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'short' }],
        },
        {
          role: 'assistant',
          reasoning_content: 'longer reasoning trace from gateway persistence',
        },
      ]),
    ).toBe('longer reasoning trace from gateway persistence')
  })
})

describe('extractStreamingThinking', () => {
  it('emits the unclosed body and keeps the tag for the next chunk', () => {
    const open = extractStreamingThinking('before <thinking>still planning')
    expect(open.displayText).toBe('before ')
    expect(open.pendingThinking).toBe('still planning')
    expect(open.extractedThinking).toBe('')
    expect(open.remainingBuffer).toBe('before <thinking>still planning')

    const closed = extractStreamingThinking(
      `${open.remainingBuffer}</thinking> after`,
    )
    expect(closed.extractedThinking).toBe('still planning')
    expect(closed.pendingThinking).toBe('')
    expect(closed.displayText).toBe('before  after')
    expect(closed.remainingBuffer).toBe('before  after')
  })

  it('holds a tag whose closing bracket has not arrived', () => {
    const split = extractStreamingThinking('hello <thinking')
    expect(split.displayText).toBe('hello ')
    expect(split.pendingThinking).toBe('')
    expect(split.remainingBuffer).toBe('hello <thinking')
  })
})

describe('consumeInlineThinking', () => {
  it('does not commit the open body twice when the tag closes', () => {
    const open = consumeInlineThinking('<thinking>plan', '')
    expect(open.liveThinking).toBe('plan')
    expect(open.closedThinking).toBe('')

    const closed = consumeInlineThinking(`${open.buffer}</thinking>`, open.closedThinking)
    expect(closed.closedThinking).toBe('plan')
    expect(closed.liveThinking).toBe('plan')
  })
})

describe('collectGatewayPayloadToolEvents', () => {
  it('emits calling from tool_calls already on the event', () => {
    const tracker = createSyntheticLiveToolTracker()
    const events = collectGatewayPayloadToolEvents({
      data: {
        tool_calls: [
          {
            id: 'toolu_1',
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/AGENTS.md"}',
            },
          },
        ],
      },
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })
    expect(events).toEqual([
      {
        phase: 'calling',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: undefined,
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })
})

describe('collectSyntheticLiveToolEvents', () => {
  it('emits a live calling event as soon as an assistant tool call appears, before any tool result exists', () => {
    const tracker = createSyntheticLiveToolTracker()

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'calling',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: undefined,
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })

  it('emits calling before complete when the tool result is already persisted', () => {
    const tracker = createSyntheticLiveToolTracker()

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: [{ type: 'text', text: 'file contents here' }],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'calling',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: undefined,
        sessionKey: 'session-1',
        runId: 'run-1',
      },
      {
        phase: 'complete',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: 'file contents here',
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })

  it('upgrades the same live tool card to complete when the matching tool result lands', () => {
    const tracker = createSyntheticLiveToolTracker()

    collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    const events = collectSyntheticLiveToolEvents({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'toolu_1',
              function: {
                name: 'read_file',
                arguments: '{"path":"/tmp/AGENTS.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: [{ type: 'text', text: 'file contents here' }],
        },
      ],
      tracker,
      sessionKey: 'session-1',
      runId: 'run-1',
    })

    expect(events).toEqual([
      {
        phase: 'complete',
        name: 'read_file',
        toolCallId: 'toolu_1',
        args: { path: '/tmp/AGENTS.md' },
        result: 'file contents here',
        sessionKey: 'session-1',
        runId: 'run-1',
      },
    ])
  })
})
