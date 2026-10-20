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
})
