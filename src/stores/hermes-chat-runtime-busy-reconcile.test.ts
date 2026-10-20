import { beforeEach, describe, expect, it } from 'vitest'
import { selectSessionMessages } from '@agorax/agent-activity-core'
import { getHermesChatRuntime } from './hermes-chat-runtime'
import { __resetRememberedOpenTurnForTests } from '@/screens/chat/lib/engine-user-prompt-ingest'
import { selectHermesChatState } from '@/screens/chat/lib/hermes-agent-engine'
import { projectChatToTranscriptRows } from '@/screens/chat/lib/agent-transcript-vm'

describe('hermes reconcileHistory while open turn remembered', () => {
  beforeEach(() => {
    __resetRememberedOpenTurnForTests()
  })

  it('keeps optimistic user across idle history poll; processing owns face', () => {
    const workspaceId = `ws-busy-${Date.now()}`
    const runtime = getHermesChatRuntime(workspaceId)
    const agentSessionId = 'sess-send'
    runtime.ensureSessionHydrated(agentSessionId)
    runtime.ingestUserPrompt({
      agentSessionId,
      clientSubmitId: 'c-send',
      text: '继续',
    })
    expect(
      selectHermesChatState(runtime.engine.getSnapshot(), agentSessionId, {
        isSubmitting: true,
      }).messages.map((m) => m.id),
    ).toEqual(['user:c-send'])

    runtime.reconcileHistory(
      agentSessionId,
      [
        {
          id: 'msg-gateway',
          messageId: 'msg-gateway',
          role: 'user',
          content: [{ type: 'text', text: '继续' }],
          timestamp: Date.now(),
        },
      ],
      1,
    )

    const ids = selectSessionMessages(
      runtime.engine.getSnapshot(),
      agentSessionId,
    ).map((m) => m.messageId)
    expect(ids).toEqual(['user:c-send'])
    expect(ids.some((id) => id.includes(':pending:'))).toBe(false)

    const chat = selectHermesChatState(runtime.engine.getSnapshot(), agentSessionId, {
      isSubmitting: true,
    })
    expect(chat.streamingMessageId).toBeNull()
    expect(
      projectChatToTranscriptRows(chat.messages, {
        turnBusy: true,
        openTurnKey: 'c-send',
      }).map((r) => r.key),
    ).toEqual(['user:c-send', 'processing:c-send'])
  })
})
