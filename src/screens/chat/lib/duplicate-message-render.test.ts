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

  it('busy history with strong ids keeps one user:<submit> + assistant:<runId>', () => {
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

    // Canonical / strong-id history (not gateway msg-N): merge by messageId.
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
        },
        {
          id: 'assistant:run-dup',
          messageId: 'assistant:run-dup',
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
      'assistant:run-dup',
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

  it('refuses grafting weak msg-* assistant under a live-only user by text', () => {
    const workspaceId = 'ws-nograft'
    const agentSessionId = 'sess-nograft'
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
      clientSubmitId: 'c-new',
      text: '继续',
      occurredAtUnixMs: 2_000,
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
          content: [{ type: 'text', text: '继续' }],
          timestamp: 1_000,
        },
        {
          id: 'msg-a',
          messageId: 'msg-a',
          role: 'assistant',
          content: [{ type: 'text', text: '旧回复' }],
          timestamp: 1_100,
        },
      ],
    })

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      isSubmitting: true,
    })
    const ids = chat.messages.map((m) => m.id || m.messageId)
    expect(ids).toContain('user:c-new')
    // Prior weak assistant must not be the only body under the new user.
    const newUserIdx = ids.indexOf('user:c-new')
    const oldAsstIdx = ids.indexOf('msg-a')
    expect(oldAsstIdx).toBeGreaterThanOrEqual(0)
    expect(oldAsstIdx).toBeLessThan(newUserIdx)
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

  it('busy history folds user-only Workspace-prefixed echo onto optimistic', () => {
    const workspaceId = 'ws-dup-ws'
    const agentSessionId = 'sess-dup-ws'
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
      clientSubmitId: 'c-ws',
      text: '开始新一轮',
      occurredAtUnixMs: 3_000,
    })

    // User-only gateway echo (no assistant yet) may fold by bare prompt.
    mergeHermesHistoryWhileBusy({
      engine,
      workspaceId,
      agentSessionId,
      historyMessages: [
        {
          id: 'msg-u',
          messageId: 'msg-u',
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Workspace::v1: /home/ramon/proj]\n开始新一轮',
            },
          ],
          timestamp: 3_001,
        },
      ],
    })

    const chat = selectHermesChatState(engine.getSnapshot(), agentSessionId, {
      isSubmitting: true,
    })
    const userIds = chat.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.id || m.messageId)
    expect(userIds).toEqual(['user:c-ws'])
    expect(
      chat.messages.find((m) => m.role === 'user')?.content?.[0],
    ).toMatchObject({ text: '开始新一轮' })
    engine.dispose()
  })
})
