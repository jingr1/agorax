import { describe, expect, it } from 'vitest'
import {
  historyCoversLiveDisplayIds,
  isDaemonCanonicalHistory,
  liveDisplayStrongIds,
  shouldFetchHistoryForSettle,
} from './hermes-display-sot'

describe('hermes display SoT', () => {
  it('lists only display-critical live strong ids', () => {
    expect(
      liveDisplayStrongIds([
        { messageId: 'user:t2' },
        { messageId: 'assistant:run_t2:thinking' },
        { messageId: 'assistant:run_t2' },
        { messageId: 'toolcall:1' },
      ]),
    ).toEqual(['user:t2', 'assistant:run_t2'])
  })

  it('rejects stale history that misses the settled live turn', () => {
    expect(
      historyCoversLiveDisplayIds(
        [
          { messageId: 'user:t1' },
          { messageId: 'assistant:run_t1' },
        ],
        [
          { messageId: 'user:t1' },
          { messageId: 'assistant:run_t1' },
          { messageId: 'user:t2' },
          { messageId: 'assistant:run_t2' },
        ],
      ),
    ).toBe(false)
  })

  it('accepts daemon pages that cover live display hosts', () => {
    expect(
      historyCoversLiveDisplayIds(
        [
          { messageId: 'user:t1' },
          { messageId: 'assistant:run_t1' },
          { messageId: 'user:t2' },
          { messageId: 'assistant:run_t2' },
        ],
        [
          { messageId: 'user:t2' },
          { messageId: 'assistant:run_t2:thinking' },
          { messageId: 'assistant:run_t2' },
        ],
      ),
    ).toBe(true)
  })

  it('detects daemon-canonical history pages', () => {
    expect(
      isDaemonCanonicalHistory([
        {
          id: 'user:a',
          messageId: 'user:a',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          __daemon: true,
        },
        {
          id: 'assistant:run_1',
          messageId: 'assistant:run_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
          __daemon: true,
        },
      ]),
    ).toBe(true)
  })

  it('rejects gateway msg-* pages as daemon-canonical', () => {
    expect(
      isDaemonCanonicalHistory([
        {
          id: 'msg-1',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
        },
      ]),
    ).toBe(false)
  })

  it('disables settle history fetch unconditionally', () => {
    expect(shouldFetchHistoryForSettle()).toBe(false)
  })
})
