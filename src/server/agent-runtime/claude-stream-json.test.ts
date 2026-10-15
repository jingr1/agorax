import { describe, expect, it } from 'vitest'
import {
  ClaudeStreamJsonParser,
  withStreamJsonOutput,
} from './claude-stream-json'

describe('withStreamJsonOutput', () => {
  it('appends stream-json flags once', () => {
    expect(withStreamJsonOutput(['-p'])).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ])
    expect(
      withStreamJsonOutput([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
      ]),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ])
  })
})

describe('ClaudeStreamJsonParser', () => {
  it('streams text_delta from content_block_delta and skips duplicate assistant text', () => {
    const parser = new ClaudeStreamJsonParser()
    const first = parser.push(
      [
        '{"type":"system","subtype":"init","model":"Kimi-K2.7-Code"}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}',
        '',
      ].join('\n'),
    )
    expect(first).toEqual([
      { type: 'thinking', text: 'Claude Code started (Kimi-K2.7-Code)' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ])

    const second = parser.push(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      })}\n`,
    )
    expect(second).toEqual([])
  })

  it('emits session from stream lines with session_id', () => {
    const parser = new ClaudeStreamJsonParser()
    const events = parser.push(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        model: 'sonnet',
      })}\n`,
    )
    expect(events).toEqual([
      {
        type: 'session',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
      { type: 'thinking', text: 'Claude Code started (sonnet)' },
    ])
  })

  it('emits tool start/end from stream_event and tool_result', () => {
    const parser = new ClaudeStreamJsonParser()
    const events = parser.push(
      [
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Write',
              input: { path: 'a.ts' },
            },
          },
        }),
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 1 },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }],
          },
        }),
        '',
      ].join('\n'),
    )
    expect(events).toEqual([
      {
        type: 'tool',
        phase: 'start',
        name: 'Write',
        args: { path: 'a.ts' },
      },
      { type: 'tool', phase: 'end', name: 'Write' },
    ])
  })

  it('falls back to plain text lines for non-JSON stdout', () => {
    const parser = new ClaudeStreamJsonParser()
    expect(parser.push('hello from fake claude\n')).toEqual([
      { type: 'text_delta', text: 'hello from fake claude\n' },
    ])
  })

  it('handles split chunks across TCP buffers', () => {
    const parser = new ClaudeStreamJsonParser()
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}\n'
    expect(parser.push(line.slice(0, 20))).toEqual([])
    expect(parser.push(line.slice(20))).toEqual([
      { type: 'text_delta', text: 'x' },
    ])
  })

  it('fails fast on system.api_retry with HTTP 429', () => {
    const parser = new ClaudeStreamJsonParser()
    expect(
      parser.push(
        [
          '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"error_status":429,"error":"rate_limit"}',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      {
        type: 'error',
        message:
          'API Error: Request rejected (429) · rate_limit (retry 1/10 aborted)',
        fatal: true,
      },
    ])
  })

  it('ignores non-429 api_retry so transient 5xx can recover', () => {
    const parser = new ClaudeStreamJsonParser()
    expect(
      parser.push(
        '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"error_status":500,"error":"server_error"}\n',
      ),
    ).toEqual([])
  })
})
