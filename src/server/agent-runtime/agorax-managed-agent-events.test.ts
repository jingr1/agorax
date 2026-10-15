import { describe, expect, it } from 'vitest'
import {
  agoraxEventsFromManagedActivity,
  assistantTextFromMessageUpdate,
} from './agorax-managed-agent-events'

describe('agoraxEventsFromManagedActivity', () => {
  it('projects assistant message deltas as text events', () => {
    expect(
      agoraxEventsFromManagedActivity('run-1', {
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        eventType: 'message_delta',
        data: {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          messageId: 'message-1',
          turnId: 'turn-1',
          role: 'assistant',
          kind: 'text',
          occurredAtUnixMs: 1,
          content: { operation: 'append_text', text: 'hello' },
        },
      }),
    ).toEqual([
      {
        type: 'activity',
        runId: 'run-1',
        workspaceId: 'default',
        activity: {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          eventType: 'message_delta',
          data: {
            workspaceId: 'workspace-1',
            agentSessionId: 'session-1',
            messageId: 'message-1',
            turnId: 'turn-1',
            role: 'assistant',
            kind: 'text',
            occurredAtUnixMs: 1,
            content: { operation: 'append_text', text: 'hello' },
          },
        },
      },
      { type: 'text_delta', runId: 'run-1', text: 'hello' },
    ])
  })

  it('does not expose user or empty message deltas', () => {
    expect(
      agoraxEventsFromManagedActivity('run-1', {
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        eventType: 'message_delta',
        data: {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          messageId: 'message-1',
          turnId: 'turn-1',
          role: 'user',
          kind: 'text',
          occurredAtUnixMs: 1,
          content: { operation: 'append_text', text: 'prompt' },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'activity',
        runId: 'run-1',
        workspaceId: 'default',
      }),
    ])
  })

  it('only projects a settled canonical turn as terminal', () => {
    const running = agoraxEventsFromManagedActivity('run-1', {
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      eventType: 'turn_update',
      data: {
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        eventType: 'turn_update',
        occurredAtUnixMs: 1,
        activeTurnId: 'turn-1',
        turn: {
          turnId: 'turn-1',
          agentSessionId: 'session-1',
          phase: 'running',
          origin: 'user_prompt',
          outcome: null,
          error: null,
          fileChanges: null,
          completedCommand: null,
          startedAtUnixMs: 1,
          settledAtUnixMs: null,
          updatedAtUnixMs: 1,
        },
      },
    })
    const failed = agoraxEventsFromManagedActivity('run-1', {
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      eventType: 'turn_update',
      data: {
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        eventType: 'turn_update',
        occurredAtUnixMs: 2,
        activeTurnId: null,
        turn: {
          turnId: 'turn-1',
          agentSessionId: 'session-1',
          phase: 'settled',
          origin: 'user_prompt',
          outcome: 'failed',
          error: { message: 'provider rejected request' },
          fileChanges: null,
          completedCommand: null,
          startedAtUnixMs: 1,
          settledAtUnixMs: 2,
          updatedAtUnixMs: 2,
        },
      },
    })

    expect(running).toEqual([
      expect.objectContaining({ type: 'activity', runId: 'run-1' }),
    ])
    expect(failed).toEqual([
      expect.objectContaining({ type: 'activity', runId: 'run-1' }),
      {
        type: 'error',
        runId: 'run-1',
        message: 'provider rejected request',
      },
      { type: 'run_exited', runId: 'run-1', exitCode: 1 },
    ])
  })

  it('extracts assistant text from durable message_update snapshots', () => {
    expect(
      assistantTextFromMessageUpdate({
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        eventType: 'message_update',
        data: {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          eventType: 'message_update',
          latestVersion: 2,
          acceptedCount: 1,
          messages: [
            {
              agentSessionId: 'session-1',
              kind: 'text',
              messageId: 'user-1',
              payload: { text: 'hi' },
              role: 'user',
              version: 1,
              turnId: 'turn-1',
              sequence: 1,
              occurredAtUnixMs: 1,
            },
            {
              agentSessionId: 'session-1',
              kind: 'text',
              messageId: 'asst-1',
              payload: {
                text: 'API Error: Request rejected (429) · Token-X quota exhausted',
              },
              role: 'assistant',
              status: 'failed',
              version: 2,
              turnId: 'turn-1',
              sequence: 2,
              occurredAtUnixMs: 2,
            },
          ],
        },
      }),
    ).toBe('API Error: Request rejected (429) · Token-X quota exhausted')
  })
})
