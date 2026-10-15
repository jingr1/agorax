import { describe, expect, it } from 'vitest'

import {
  advanceStickyStreamingText,
  buildChatNavKey,
  createResponseWaitSnapshot,
  hasFinalAssistantWriteThrough,
  isRetryableUserMessage,
  isTerminalActiveRunStatus,
  profileNameFromNavKey,
  shouldCancelStreamOnSessionNav,
  shouldClearWaitingForAssistantMessage,
  shouldHandoffStreamOnProfileNav,
  shouldSettleWaitingFromActiveRun,
} from './chat-screen-utils'

describe('advanceStickyStreamingText', () => {
  it('preserves the last non-empty streaming text when a tool phase temporarily reports empty text', () => {
    const afterText = advanceStickyStreamingText({
      isStreaming: true,
      runId: 'run-1',
      rawText: 'Working through the task',
      smoothedText: 'Working through the task',
      previousState: { runId: null, text: '' },
    })

    const afterToolPhase = advanceStickyStreamingText({
      isStreaming: true,
      runId: 'run-1',
      rawText: '',
      smoothedText: '',
      previousState: afterText,
    })

    expect(afterToolPhase).toEqual({
      runId: 'run-1',
      text: 'Working through the task',
    })
  })

  it('resets sticky text when a new run starts', () => {
    const next = advanceStickyStreamingText({
      isStreaming: true,
      runId: 'run-2',
      rawText: '',
      smoothedText: '',
      previousState: { runId: 'run-1', text: 'Old stream text' },
    })

    expect(next).toEqual({ runId: 'run-2', text: '' })
  })

  it('clears sticky text when streaming ends', () => {
    const next = advanceStickyStreamingText({
      isStreaming: false,
      runId: null,
      rawText: '',
      smoothedText: '',
      previousState: { runId: 'run-1', text: 'Old stream text' },
    })

    expect(next).toEqual({ runId: null, text: '' })
  })
})

describe('shouldCancelStreamOnSessionNav', () => {
  it('does not cancel on the first session key', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: null,
        nextNavKey: '::new',
        nextFriendlyId: 'new',
      }),
    ).toBe(false)
  })

  it('does not cancel when the nav key is unchanged', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'abc::abc',
        nextNavKey: 'abc::abc',
        nextFriendlyId: 'abc',
        activeSendKey: 'abc',
      }),
    ).toBe(false)
  })

  it('keeps the first-turn stream when promoting /chat/new onto the in-flight session', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'main::new',
        nextNavKey: 'thread-1::thread-1',
        nextFriendlyId: 'thread-1',
        activeSendKey: 'thread-1',
      }),
    ).toBe(false)
  })

  it('keeps the first-turn stream when promoting /chat/new before activeSendRef is set', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'aider::::new',
        nextNavKey: 'aider::::thread-1',
        nextFriendlyId: 'thread-1',
      }),
    ).toBe(false)
  })

  it('does not cancel when canonical session key fills in on the same thread', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'aider::::thread-1',
        nextNavKey: 'aider::thread-1::thread-1',
        nextFriendlyId: 'thread-1',
        activeSendKey: 'thread-1',
      }),
    ).toBe(false)
  })

  it('cancels when the user leaves a streaming session for a different one', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'session-a::session-a',
        nextNavKey: 'session-b::session-b',
        nextFriendlyId: 'session-b',
        activeSendKey: 'session-a',
      }),
    ).toBe(true)
  })

  it('cancels when opening a new chat from an existing session', () => {
    expect(
      shouldCancelStreamOnSessionNav({
        previousNavKey: 'session-a::session-a',
        nextNavKey: 'main::new',
        nextFriendlyId: 'new',
        activeSendKey: 'session-a',
      }),
    ).toBe(true)
  })
})

describe('profile stream handoff navigation', () => {
  it('builds nav keys with profile prefix', () => {
    expect(
      buildChatNavKey({
        profileName: 'developer',
        canonicalSessionKey: 'thread-1',
        friendlyId: 'thread-1',
        isNewChat: false,
      }),
    ).toBe('developer::thread-1::thread-1')
  })

  it('detects profile-only navigation for handoff', () => {
    const prev = buildChatNavKey({
      profileName: 'developer',
      canonicalSessionKey: 'a',
      friendlyId: 'a',
      isNewChat: false,
    })
    const next = buildChatNavKey({
      profileName: 'architect',
      canonicalSessionKey: 'b',
      friendlyId: 'b',
      isNewChat: false,
    })
    expect(shouldHandoffStreamOnProfileNav(prev, next)).toBe(true)
    expect(shouldHandoffStreamOnProfileNav(prev, prev)).toBe(false)
    expect(profileNameFromNavKey(prev)).toBe('developer')
  })
})

describe('response wait detection', () => {
  it('treats persisted complete runs as terminal', () => {
    expect(isTerminalActiveRunStatus('complete')).toBe(true)
    expect(isTerminalActiveRunStatus('completed')).toBe(true)
    expect(isTerminalActiveRunStatus('interrupted')).toBe(true)
    expect(isTerminalActiveRunStatus('active')).toBe(false)
  })

  it('settles waiting when active-run is missing or terminal', () => {
    expect(shouldSettleWaitingFromActiveRun(null)).toBe('missing')
    expect(shouldSettleWaitingFromActiveRun({ status: 'complete' })).toBe(
      'settle',
    )
    expect(shouldSettleWaitingFromActiveRun({ status: 'interrupted' })).toBe(
      'settle',
    )
    expect(shouldSettleWaitingFromActiveRun({ status: 'active' })).toBe('keep')
    expect(shouldSettleWaitingFromActiveRun({ status: 'handoff' })).toBe('keep')
  })

  it('clears waiting when a new assistant message appears after the send snapshot', () => {
    const snapshot = createResponseWaitSnapshot([
      {
        role: 'user',
        content: [{ type: 'text', text: 'remember that i like cheesecake' }],
      },
    ])

    expect(
      shouldClearWaitingForAssistantMessage(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'remember that i like cheesecake' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Remembered: you like cheesecake.' },
            ],
            id: 'assistant-1',
          },
        ],
        snapshot,
      ),
    ).toBe(true)
  })

  it('clears waiting for thinking-only rows once they have surface', () => {
    const snapshot = createResponseWaitSnapshot([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    ])

    expect(
      shouldClearWaitingForAssistantMessage(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'planning the reply' }],
            id: 'assistant-thinking',
          },
        ],
        snapshot,
      ),
    ).toBe(true)
  })

  it('keeps waiting for empty assistant placeholders', () => {
    const snapshot = createResponseWaitSnapshot([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    ])

    expect(
      shouldClearWaitingForAssistantMessage(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
          {
            role: 'assistant',
            content: [],
            id: 'assistant-empty',
          },
        ],
        snapshot,
      ),
    ).toBe(false)
  })

  it('clears waiting when the same assistant row is rewritten with interrupt text', () => {
    const snapshot = createResponseWaitSnapshot([
      {
        role: 'user',
        content: [{ type: 'text', text: 'long task' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        id: 'assistant-1',
      },
    ])

    expect(
      shouldClearWaitingForAssistantMessage(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: 'long task' }],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Operation interrupted: waiting for model response',
              },
            ],
            id: 'assistant-1',
          },
        ],
        snapshot,
      ),
    ).toBe(true)
  })
})

describe('hasFinalAssistantWriteThrough', () => {
  it('rejects thinking-only / empty assistant rows', () => {
    expect(hasFinalAssistantWriteThrough([])).toBe(false)
    expect(
      hasFinalAssistantWriteThrough([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'plan only' }],
        } as never,
      ]),
    ).toBe(false)
    expect(
      hasFinalAssistantWriteThrough([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'read_file' }],
        } as never,
      ]),
    ).toBe(false)
  })

  it('accepts final text or explicit error bubbles', () => {
    expect(
      hasFinalAssistantWriteThrough([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'text', text: 'answer' },
          ],
        } as never,
      ]),
    ).toBe(true)
    expect(
      hasFinalAssistantWriteThrough([
        {
          role: 'assistant',
          content: [],
          isError: true,
        } as never,
      ]),
    ).toBe(true)
  })
})

describe('isRetryableUserMessage', () => {
  it('resends a stuck sending message only when the user clicks Retry', () => {
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      status: 'sending' as const,
    }

    expect(isRetryableUserMessage(message, 'manual')).toBe(true)
    expect(isRetryableUserMessage(message, 'auto')).toBe(false)
  })

  it('resends an error message on both manual and auto retry', () => {
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      status: 'error' as const,
    }

    expect(isRetryableUserMessage(message, 'manual')).toBe(true)
    expect(isRetryableUserMessage(message, 'auto')).toBe(true)
  })

  it('does not resend a delivered queued message', () => {
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      status: 'queued' as const,
    }

    expect(isRetryableUserMessage(message, 'manual')).toBe(false)
    expect(isRetryableUserMessage(message, 'auto')).toBe(false)
  })
})
