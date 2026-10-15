import { describe, expect, it } from 'vitest'
import {
  hermesHistoryMessagesToActivity,
  isWeakHermesGatewayMessageId,
  mergeHermesHistoryWithLiveByTurnIdentity,
} from './hermes-history-to-activity'
import type { AgentActivityDurableMessage } from '@agorax/agent-activity-core'

describe('hermesHistoryMessagesToActivity', () => {
  it('preserves assistant:<runId> and expands thinking + text', () => {
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 10,
        },
        {
          role: 'assistant',
          id: 'assistant:run-9',
          messageId: 'assistant:run-9',
          runId: 'run-9',
          content: [
            { type: 'thinking', thinking: 'plan' },
            { type: 'text', text: 'hello' },
          ],
          timestamp: 20,
        },
      ],
    })
    expect(rows.map((row) => row.messageId)).toEqual([
      'user-1',
      'assistant:run-9:thinking',
      'assistant:run-9',
    ])
    expect(rows[2]).toMatchObject({
      role: 'assistant',
      kind: 'text',
      payload: { text: 'hello' },
    })
  })

  it('maps toolCall parts to toolcall: ids', () => {
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          id: 'assistant:run-t',
          content: [
            {
              type: 'toolCall',
              id: 'tc-1',
              name: 'read_file',
              arguments: { path: 'a.ts' },
            },
            { type: 'text', text: 'done' },
          ],
          timestamp: 1,
        },
      ],
    })
    expect(rows[0]).toMatchObject({
      messageId: 'toolcall:tc-1',
      kind: 'tool_call',
      payload: { toolName: 'read_file' },
    })
    expect(rows[1]?.messageId).toBe('assistant:run-t')
  })

  it('treats msg-N as weak; prefers runId when present', () => {
    expect(isWeakHermesGatewayMessageId('msg-3')).toBe(true)
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          id: 'msg-3',
          runId: 'run-9',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: 1,
        },
      ],
    })
    expect(rows[0]?.messageId).toBe('assistant:run-9')
  })

  it('skips exact duplicate messageIds inside one history page', () => {
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'user',
          id: 'user:submit',
          content: [{ type: 'text', text: 'a' }],
          timestamp: 1,
        },
        {
          role: 'user',
          id: 'user:submit',
          content: [{ type: 'text', text: 'a' }],
          timestamp: 2,
        },
      ],
    })
    expect(rows).toHaveLength(1)
  })
})

describe('mergeHermesHistoryWithLiveByTurnIdentity', () => {
  const base = {
    workspaceId: 'ws',
    agentSessionId: 's',
    version: 1,
    sequence: 1,
    status: null as string | null,
    occurredAtUnixMs: 1,
  }

  it('stamps live durable ids onto the paired history turn (msg-N → assistant:run)', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'msg-1',
        turnId: 'turn-msg-1',
        role: 'user',
        kind: 'text',
        payload: { text: '你在干嘛？' },
      },
      {
        ...base,
        messageId: 'msg-2',
        turnId: 'turn-msg-2',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '在待命，等你安排任务。' },
        occurredAtUnixMs: 2,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:c1',
        turnId: 'turn-c1',
        role: 'user',
        kind: 'text',
        payload: { text: '你在干嘛？', clientSubmitId: 'c1' },
      },
      {
        ...base,
        messageId: 'assistant:run-live',
        turnId: 'turn-c1',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '在待命，等你安排任务。' },
        occurredAtUnixMs: 2,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'user:c1',
      'assistant:run-live',
    ])
    expect(merged).toHaveLength(2)
  })

  it('keeps older history turns that have no live pair', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'msg-old-u',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: 'old' },
      },
      {
        ...base,
        messageId: 'msg-old-a',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: 'old reply' },
        occurredAtUnixMs: 2,
      },
      {
        ...base,
        messageId: 'msg-1',
        turnId: 'turn-new',
        role: 'user',
        kind: 'text',
        sequence: 3,
        version: 3,
        payload: { text: 'new' },
        occurredAtUnixMs: 3,
      },
      {
        ...base,
        messageId: 'msg-2',
        turnId: 'turn-new',
        role: 'assistant',
        kind: 'text',
        sequence: 4,
        version: 4,
        payload: { text: 'new reply' },
        occurredAtUnixMs: 4,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:fresh',
        turnId: 'turn-fresh',
        role: 'user',
        kind: 'text',
        payload: { text: 'new', clientSubmitId: 'fresh' },
        occurredAtUnixMs: 3,
      },
      {
        ...base,
        messageId: 'assistant:run-x',
        turnId: 'turn-fresh',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: 'new reply' },
        occurredAtUnixMs: 4,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'msg-old-u',
      'msg-old-a',
      'user:fresh',
      'assistant:run-x',
    ])
  })

  it('pairs history msg-N onto live pending host via submit nonce', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'msg-1',
        turnId: 'turn-msg-1',
        role: 'user',
        kind: 'text',
        payload: { text: 'status?' },
      },
      {
        ...base,
        messageId: 'msg-2',
        turnId: 'turn-msg-2',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: 'Not done yet.' },
        occurredAtUnixMs: 2,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:c-status',
        turnId: 'turn-c-status',
        role: 'user',
        kind: 'text',
        payload: { text: 'status?', clientSubmitId: 'c-status' },
      },
      {
        ...base,
        messageId: 'assistant:pending:s:c-status',
        turnId: 'turn-c-status',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: 'Not done yet.' },
        occurredAtUnixMs: 2,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'user:c-status',
      'assistant:pending:s:c-status',
    ])
  })

  it('keeps trailing live-only turn when history lags', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'msg-1',
        turnId: 'turn-1',
        role: 'user',
        kind: 'text',
        payload: { text: 'old' },
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'msg-1',
        turnId: 'turn-1',
        role: 'user',
        kind: 'text',
        payload: { text: 'old' },
      },
      {
        ...base,
        messageId: 'user:fresh',
        turnId: 'turn-fresh',
        role: 'user',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: 'new prompt' },
        occurredAtUnixMs: 2,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'msg-1',
      'user:fresh',
    ])
  })

  it('does not ordinal-pair a stale history turn onto a newer live-only turn', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'msg-old',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: 'old' },
        occurredAtUnixMs: 1,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:fresh',
        turnId: 'turn-fresh',
        role: 'user',
        kind: 'text',
        payload: { text: 'new prompt', clientSubmitId: 'fresh' },
        occurredAtUnixMs: Date.now(),
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'msg-old',
      'user:fresh',
    ])
  })
})
