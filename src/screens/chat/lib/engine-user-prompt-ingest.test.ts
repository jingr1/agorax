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

describe('ingestEngineUserPromptMessage', () => {
  it('seeds only optimistic user; open-turn face is transcript processing', () => {
    const workspaceId = 'ws'
    const commandPort = createHermesCommandPort({
      workspaceId,
      getMapping: async () => null,
      putMapping: async (m) => m,
      onActivityEvent: () => undefined,
    })
    const engine = createHermesAgentEngine({ workspaceId, commandPort })
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
        workspaceId,
        agentSessionId: 'sess-1',
        clientSubmitId: 'c-continue',
        text: '继续',
        occurredAtUnixMs: 1_700_000_000_000,
      }),
    ).toBe(true)

    expect(
      selectSessionMessages(engine.getSnapshot(), 'sess-1').map(
        (m) => m.messageId,
      ),
    ).toEqual(['user:c-continue'])
    expect(getRememberedOpenTurn('sess-1')).toEqual({
      clientSubmitId: 'c-continue',
      turnId: 'turn-c-continue',
    })

    const chat = selectHermesChatState(engine.getSnapshot(), 'sess-1', {
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
    engine.dispose()
  })
})
