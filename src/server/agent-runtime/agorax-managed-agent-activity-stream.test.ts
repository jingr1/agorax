import { describe, expect, it, vi } from 'vitest'
import {
  AgoraxManagedAgentActivityStream,
  parseAgoraxManagedActivityFrame,
} from './agorax-managed-agent-activity-stream'

const frame = {
  kind: 'event' as const,
  event: {
    topic: 'agent.activity.updated' as const,
    payload: {
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      eventType: 'message_delta' as const,
      data: {
        agentSessionId: 'session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        content: { operation: 'append_text' as const, text: 'hello' },
      },
    },
  },
}

describe('AgoraxManagedAgentActivityStream', () => {
  it('accepts only the requested workspace and session activity', () => {
    expect(
      parseAgoraxManagedActivityFrame(frame, 'workspace-1', 'session-1'),
    ).not.toBeNull()
    expect(
      parseAgoraxManagedActivityFrame(frame, 'workspace-2', 'session-1'),
    ).toBeNull()
    expect(parseAgoraxManagedActivityFrame({ kind: 'ready' }, 'workspace-1', 'session-1')).toBeNull()
  })

  it('projects accepted activity and closes the injected socket', () => {
    const onMessage: Array<(raw: unknown) => void> = []
    const close = vi.fn()
    const onEvents = vi.fn()
    const stream = new AgoraxManagedAgentActivityStream({
      url: 'ws://127.0.0.1:8642/v1/events/ws',
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      runId: 'run-1',
      socketFactory: () => ({
        onMessage: (listener) => onMessage.push(listener),
        onError: () => undefined,
        close,
      }),
      onEvents,
    })

    stream.connect()
    onMessage[0]!(frame)
    expect(onEvents).toHaveBeenCalledWith([
      {
        type: 'activity',
        runId: 'run-1',
        workspaceId: 'workspace-1',
        activity: {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          eventType: 'message_delta',
          data: {
            agentSessionId: 'session-1',
            messageId: 'message-1',
            turnId: 'turn-1',
            role: 'assistant',
            kind: 'text',
            content: { operation: 'append_text', text: 'hello' },
          },
        },
      },
      { type: 'text_delta', runId: 'run-1', text: 'hello' },
    ])
    stream.close()
    expect(close).toHaveBeenCalledOnce()
  })
})