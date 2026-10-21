/**
 * Architectural lock for chat turn invariants (the bugs that patches kept
 * missing):
 *
 * 1. While turn N is open, ingest of turn N+1 user must be refused.
 * 2. Prior assistant must stay above the latest user (no fold relocate).
 * 3. List caret binds only to Engine streaming host after the latest user.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { selectSessionMessages } from '@agorax/agent-activity-core'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  selectHermesChatState,
} from './hermes-agent-engine'
import {
  __resetRememberedOpenTurnForTests,
  clearRememberedOpenTurn,
  ingestEngineUserPromptMessage,
} from './engine-user-prompt-ingest'
import { projectChatToTranscriptRows } from './agent-transcript-vm'
import { deriveHermesListStreamingChrome } from '../chat-screen-utils'
import { applyOpenAssistantStreamingChrome } from './engine-open-assistant-stream'
import type { ChatMessage } from '../types'

describe('chat turn invariants (architectural)', () => {
  beforeEach(() => {
    __resetRememberedOpenTurnForTests()
  })

  it('refuses a second user ingest while the prior open turn is remembered', () => {
    const workspaceId = 'ws-inv'
    const agentSessionId = 'sess-inv'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({ workspaceId, agentSessionId }),
    )

    expect(
      ingestEngineUserPromptMessage({
        engine,
        workspaceId,
        agentSessionId,
        clientSubmitId: 'c1',
        text: '第一轮',
        occurredAtUnixMs: 1_000,
      }),
    ).toBe(true)

    // Mid-stream assistant for turn 1 (still open).
    engine.dispatch({
      type: 'message/snapshotReceived',
      messages: [
        {
          workspaceId,
          agentSessionId,
          messageId: 'assistant:run-1',
          version: 1_001,
          sequence: 1_001,
          turnId: 'turn-c1',
          role: 'assistant',
          kind: 'text',
          status: 'streaming',
          payload: { text: '旧回复还在生成……官方 Skill 是上游最小起点' },
          occurredAtUnixMs: 1_001,
        },
      ],
    })

    // Follow-up while busy — must NOT enter the Engine list.
    expect(
      ingestEngineUserPromptMessage({
        engine,
        workspaceId,
        agentSessionId,
        clientSubmitId: 'c2',
        text: 'setcap 跑完了',
        occurredAtUnixMs: 2_000,
      }),
    ).toBe(false)

    const ids = selectSessionMessages(engine.getSnapshot(), agentSessionId).map(
      (m) => m.messageId,
    )
    expect(ids).toEqual(['user:c1', 'assistant:run-1'])
    expect(ids).not.toContain('user:c2')

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      isSubmitting: true,
    })
    expect(chat.messages.map((m) => m.messageId ?? m.id)).toEqual([
      'user:c1',
      'assistant:run-1',
    ])

    // Even if UI wrongly ORs a stale store id, list chrome must stay Engine-only.
    const chrome = deriveHermesListStreamingChrome({
      engineIsStreaming: chat.isStreaming,
      engineStreamingMessageId: chat.streamingMessageId,
      localIsStreaming: true,
    })
    // Open host is after last user — caret may bind to run-1 while still open.
    // Critical: after a *queued* follow-up that did NOT ingest, last user is still c1.
    expect(chrome.streamingMessageId === null || chrome.streamingMessageId === 'assistant:run-1').toBe(
      true,
    )

    engine.dispose()
  })

  it('does not relocate a prior live reply under a later user when chrome is applied', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user:1',
        messageId: 'user:1',
        role: 'user',
        content: [{ type: 'text', text: '旧问题' }],
        timestamp: 1,
      },
      {
        id: 'assistant:run-live',
        messageId: 'assistant:run-live',
        role: 'assistant',
        __streamingStatus: 'streaming',
        content: [{ type: 'text', text: '旧回复还在生成' }],
        timestamp: 2,
      },
      {
        id: 'user:2',
        messageId: 'user:2',
        role: 'user',
        content: [{ type: 'text', text: 'setcap 跑完了' }],
        timestamp: 3,
      },
    ]
    const chrome = applyOpenAssistantStreamingChrome({
      messages,
      activityStreamingId: 'assistant:run-live',
      turnActive: true,
      submitting: true,
    })
    expect(chrome.streamingMessageId).toBeNull()
    expect(chrome.messages.map((m) => m.messageId ?? m.id)).toEqual([
      'user:1',
      'assistant:run-live',
      'user:2',
    ])
    expect(
      (chrome.messages[1]?.content as Array<{ text?: string }>)?.[0]?.text,
    ).toBe('旧回复还在生成')

    const listChrome = deriveHermesListStreamingChrome({
      engineIsStreaming: true,
      engineStreamingMessageId: chrome.streamingMessageId,
      localIsStreaming: true,
    })
    expect(listChrome.streamingMessageId).toBeNull()

    const rows = projectChatToTranscriptRows(chrome.messages, {
      turnBusy: true,
      openTurnKey: '2',
      streamingMessageId: listChrome.streamingMessageId,
    })
    expect(rows.map((r) => r.key)).toEqual([
      'user:1',
      'assistant:run-live',
      'user:2',
      'processing:2',
    ])
  })

  it('keeps prior assistant above the new user when fold sees a stale live id', () => {
    const messages: ChatMessage[] = [
      {
        id: 'user:old',
        messageId: 'user:old',
        role: 'user',
        content: [{ type: 'text', text: '旧问题' }],
        timestamp: 1,
      },
      {
        id: 'assistant:run-old',
        messageId: 'assistant:run-old',
        role: 'assistant',
        __streamingStatus: 'streaming',
        content: [{ type: 'text', text: '旧回复还在' }],
        timestamp: 2,
      },
      {
        id: 'user:new',
        messageId: 'user:new',
        role: 'user',
        content: [{ type: 'text', text: '新问题' }],
        timestamp: 3,
      },
    ]
    const chrome = applyOpenAssistantStreamingChrome({
      messages,
      activityStreamingId: 'assistant:run-old',
      turnActive: true,
      submitting: true,
    })
    expect(chrome.streamingMessageId).toBeNull()
    expect(chrome.messages.map((m) => m.messageId ?? m.id)).toEqual([
      'user:old',
      'assistant:run-old',
      'user:new',
    ])
    expect(
      (chrome.messages[1]?.content as Array<{ text?: string }>)?.[0]?.text,
    ).toBe('旧回复还在')
  })

  it('allows the next ingest only after the remembered open turn is cleared', () => {
    const workspaceId = 'ws-inv2'
    const agentSessionId = 'sess-inv2'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({ workspaceId, agentSessionId }),
    )

    expect(
      ingestEngineUserPromptMessage({
        engine,
        workspaceId,
        agentSessionId,
        clientSubmitId: 'a',
        text: 'hi',
        occurredAtUnixMs: 1,
      }),
    ).toBe(true)
    clearRememberedOpenTurn(agentSessionId)
    expect(
      ingestEngineUserPromptMessage({
        engine,
        workspaceId,
        agentSessionId,
        clientSubmitId: 'b',
        text: 'next',
        occurredAtUnixMs: 2,
      }),
    ).toBe(true)
    expect(
      selectSessionMessages(engine.getSnapshot(), agentSessionId).map(
        (m) => m.messageId,
      ),
    ).toEqual(['user:a', 'user:b'])
    engine.dispose()
  })
})
