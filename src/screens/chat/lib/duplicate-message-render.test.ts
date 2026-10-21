import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  ingestHermesUserPromptMessage,
  mergeHermesHistoryWhileBusy,
  selectHermesChatState,
} from './hermes-agent-engine'
import { __resetRememberedOpenTurnForTests } from './engine-user-prompt-ingest'
import { projectChatToTranscriptRows } from './agent-transcript-vm'

describe('no dual assistant id families', () => {
  beforeEach(() => {
    __resetRememberedOpenTurnForTests()
  })

  it('busy history folds msg-* onto optimistic user; processing key stays', () => {
    const workspaceId = 'ws-dup'
    const agentSessionId = 'sess-dup'
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
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId,
      clientSubmitId: 'c-dup',
      text: '继续排查',
      occurredAtUnixMs: 1_000,
    })

    mergeHermesHistoryWhileBusy({
      engine,
      workspaceId,
      agentSessionId,
      historyMessages: [
        {
          id: 'msg-u',
          messageId: 'msg-u',
          role: 'user',
          content: [{ type: 'text', text: '继续排查' }],
          timestamp: 1_001,
        },
        {
          id: 'msg-a',
          messageId: 'msg-a',
          role: 'assistant',
          content: [{ type: 'text', text: '收到，继续。' }],
          timestamp: 1_002,
        },
      ],
    })

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      isSubmitting: true,
    })
    expect(chat.messages.map((m) => m.id || m.messageId)).toEqual([
      'user:c-dup',
      'msg-a',
    ])
    expect(
      chat.messages.some((m) =>
        String(m.id || m.messageId).includes(':pending:'),
      ),
    ).toBe(false)

    const rows = projectChatToTranscriptRows(chat.messages, {
      turnBusy: chat.turnBusy,
      streamingMessageId: chat.streamingMessageId,
      openTurnKey: 'c-dup',
    })
    expect(rows.map((r) => r.kind)).toEqual([
      'message',
      'processing',
      'message',
    ])
    expect(rows[1]?.key).toBe('processing:c-dup')
    engine.dispose()
  })

  it('busy history folds RQ optimistic + msg-* onto one live user', () => {
    const workspaceId = 'ws-dup2'
    const agentSessionId = 'sess-dup2'
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
    ingestHermesUserPromptMessage({
      engine,
      workspaceId,
      agentSessionId,
      clientSubmitId: 'c-opt',
      text: '不要让我做这做那的，自己想办法解决',
      occurredAtUnixMs: 2_000,
    })

    mergeHermesHistoryWhileBusy({
      engine,
      workspaceId,
      agentSessionId,
      historyMessages: [
        {
          role: 'user',
          clientId: 'c-opt',
          client_id: 'c-opt',
          __optimisticId: 'opt-c-opt',
          content: [
            { type: 'text', text: '不要让我做这做那的，自己想办法解决' },
          ],
          timestamp: 2_000,
        },
        {
          id: 'msg-u',
          messageId: 'msg-u',
          role: 'user',
          content: [
            { type: 'text', text: '不要让我做这做那的，自己想办法解决' },
          ],
          timestamp: 2_001,
        },
      ],
    })

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      isSubmitting: true,
    })
    const userIds = chat.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.id || m.messageId)
    expect(userIds).toEqual(['user:c-opt'])
    engine.dispose()
  })
})
