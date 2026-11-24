import { describe, expect, it } from 'vitest'
import { selectSessionMessages } from '@agorax/agent-activity-core'
import {
  createHermesAgentEngine,
  createHermesCommandPort,
  createHermesSessionSkeleton,
  hydrateHermesAgentEngine,
  selectHermesChatState,
} from './hermes-agent-engine'
import {
  getRememberedOpenTurn,
  ingestEngineUserPromptMessage,
} from './engine-user-prompt-ingest'
import { projectChatToTranscriptRows } from './agent-transcript-vm'
import { createTestActivityCoordinator } from './test-activity-coordinator'

describe('ingestEngineUserPromptMessage', () => {
  it('seeds optimistic user into overlay only; Engine bucket stays empty', () => {
    const workspaceId = 'ws'
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
      createHermesSessionSkeleton({
        workspaceId,
        agentSessionId: 'sess-1',
      }),
    )
    expect(
      ingestEngineUserPromptMessage({
        engine,
        seedOptimisticMessage: (message) =>
          coordinator.seedOptimisticMessage(message),
        workspaceId,
        agentSessionId: 'sess-1',
        clientSubmitId: 'c-continue',
        text: '继续',
        occurredAtUnixMs: 1_700_000_000_000,
      }),
    ).toBe(true)

    // Tutti contract: durable Engine bucket has no optimistic user.
    expect(selectSessionMessages(engine.getSnapshot(), 'sess-1')).toEqual([])
    expect(getRememberedOpenTurn('sess-1')).toEqual({
      clientSubmitId: 'c-continue',
      turnId: 'turn-c-continue',
    })

    const sessionMessages = coordinator.project(
      project(engine.getSnapshot()),
    ).sessionMessagesById['sess-1']
    const chat = selectHermesChatState(engine.getSnapshot(), 'sess-1', {
      sessionMessages,
      isSubmitting: true,
    })
    expect(chat.turnBusy).toBe(true)
    expect(chat.streamingMessageId).toBeNull()
    expect(
      projectChatToTranscriptRows(chat.messages, {
        turnBusy: true,
        openTurnKey: 'c-continue',
      }).map((r) => r.key),
    ).toEqual(['user:c-continue', 'processing:c-continue'])
    coordinator.dispose()
    engine.dispose()
  })
})
