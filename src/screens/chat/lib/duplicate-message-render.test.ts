import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  ingestHermesUserPromptMessage,
  mergeHermesHistoryWhileBusy,
  reconcileHermesHistoryIntoEngine,
  selectHermesChatState,
} from './hermes-agent-engine'
import { __resetRememberedOpenTurnForTests } from './engine-user-prompt-ingest'
import { createTestActivityCoordinator } from './test-activity-coordinator'
import { projectChatToTranscriptRows } from './agent-transcript-vm'
import type { AgentActivityDurableMessage } from '@agorax/agent-activity-core'

describe('Hermes display SoT (no busy history merge)', () => {
  beforeEach(() => {
    __resetRememberedOpenTurnForTests()
  })

  it('busy history reconcile is a no-op — SSE owns the open turn', () => {
    const workspaceId = 'ws-dup'
    const agentSessionId = 'sess-dup'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const { coordinator, project } = createTestActivityCoordinator({
      engine,
      workspaceId,
    })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({ workspaceId, agentSessionId }),
    )
    ingestHermesUserPromptMessage({
      engine,
      coordinator,
      workspaceId,
      agentSessionId,
      clientSubmitId: 'c-dup',
      text: '继续排查',
      occurredAtUnixMs: 1_000,
    })

    const before = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      sessionMessages: coordinator.project(project(engine.getSnapshot()))
        .sessionMessagesById[agentSessionId],
      isSubmitting: true,
    }).messages.map((m) => m.id || m.messageId)

    expect(
      mergeHermesHistoryWhileBusy({
        engine,
        workspaceId,
        agentSessionId,
        historyMessages: [
          {
            id: 'user:c-dup',
            messageId: 'user:c-dup',
            role: 'user',
            clientSubmitId: 'c-dup',
            content: [{ type: 'text', text: '继续排查' }],
            timestamp: 1_001,
            __daemon: true,
          },
          {
            id: 'assistant:run-dup',
            messageId: 'assistant:run-dup',
            role: 'assistant',
            content: [{ type: 'text', text: '收到，继续。' }],
            timestamp: 1_002,
            __daemon: true,
          },
        ],
      }),
    ).toBe(0)

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      sessionMessages: coordinator.project(project(engine.getSnapshot()))
        .sessionMessagesById[agentSessionId],
      isSubmitting: true,
    })
    expect(chat.messages.map((m) => m.id || m.messageId)).toEqual(before)
    expect(chat.messages.map((m) => m.id || m.messageId)).toEqual([
      'user:c-dup',
    ])

    const rows = projectChatToTranscriptRows(chat.messages, {
      turnBusy: true,
      streamingMessageId: null,
      openTurnKey: 'c-dup',
    })
    expect(rows.map((r) => r.kind)).toEqual(['message', 'processing'])
    expect(rows[1]?.key).toBe('processing:c-dup')
    coordinator.dispose()
    engine.dispose()
  })

  it('idle daemon history replaces Engine without length-win merge', () => {
    const workspaceId = 'ws-idle'
    const agentSessionId = 'sess-idle'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
    const { coordinator } = createTestActivityCoordinator({
      engine,
      workspaceId,
    })
    hydrateHermesAgentEngine(
      engine,
      createHermesSessionSkeleton({ workspaceId, agentSessionId }),
    )
    ingestHermesUserPromptMessage({
      engine,
      coordinator,
      workspaceId,
      agentSessionId,
      clientSubmitId: 't1',
      text: '非常好',
      occurredAtUnixMs: 1,
    })

    reconcileHermesHistoryIntoEngine({
      engine,
      coordinator,
      workspaceId,
      agentSessionId,
      historyMessages: [
        {
          id: 'user:t1',
          messageId: 'user:t1',
          role: 'user',
          turnId: 'turn-t1',
          clientSubmitId: 't1',
          content: [{ type: 'text', text: '非常好' }],
          timestamp: 1,
          __daemon: true,
        },
        {
          id: 'assistant:run_t1',
          messageId: 'assistant:run_t1',
          role: 'assistant',
          turnId: 'turn-t1',
          content: [{ type: 'text', text: '谢。' }],
          timestamp: 2,
          __daemon: true,
        },
        {
          id: 'user:t2',
          messageId: 'user:t2',
          role: 'user',
          turnId: 'turn-t2',
          clientSubmitId: 't2',
          content: [{ type: 'text', text: '回答怎么这么简洁' }],
          timestamp: 10,
          __daemon: true,
        },
        {
          id: 'assistant:run_t2',
          messageId: 'assistant:run_t2',
          role: 'assistant',
          turnId: 'turn-t2',
          content: [
            {
              type: 'text',
              text: '你之前让我只回复一个字：好，我按那个风格延续了。',
            },
          ],
          timestamp: 11,
          __daemon: true,
        },
      ],
    })

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId)
    expect(chat.messages.map((m) => m.id || m.messageId)).toEqual([
      'user:t1',
      'assistant:run_t1',
      'user:t2',
      'assistant:run_t2',
    ])
    const t1 = chat.messages.find(
      (m) => (m.id || m.messageId) === 'assistant:run_t1',
    )
    expect(JSON.stringify(t1)).toContain('谢。')
    expect(JSON.stringify(t1)).not.toContain('只回复一个字')
    coordinator.dispose()
    engine.dispose()
  })
})
