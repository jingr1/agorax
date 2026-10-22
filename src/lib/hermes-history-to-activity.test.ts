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

  it('maps optimistic clientId to user:<clientId> and drops msg-* twin', () => {
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'user',
          clientId: 'c-opt',
          client_id: 'c-opt',
          __optimisticId: 'opt-c-opt',
          content: [{ type: 'text', text: '继续排查' }],
          timestamp: 1_000,
        },
        {
          role: 'user',
          id: 'msg-u',
          content: [{ type: 'text', text: '继续排查' }],
          timestamp: 1_001,
        },
      ],
    })
    expect(rows.map((row) => row.messageId)).toEqual(['user:c-opt'])
    expect(rows[0]?.payload).toMatchObject({ clientSubmitId: 'c-opt' })
  })

  it('strips Workspace::v1 so gateway echo matches bare optimistic prompt', () => {
    // Root cause of double user bubbles: one send → plain live + prefixed
    // history. Mapping must normalize before identity merge / twin absorb.
    const rows = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 'sess-1',
      messages: [
        {
          role: 'user',
          clientId: 'c-opt',
          content: [{ type: 'text', text: '开始新一轮' }],
          timestamp: 1_000,
        },
        {
          role: 'user',
          id: 'msg-u',
          content: [
            {
              type: 'text',
              text: '[Workspace::v1: /tmp/proj]\n开始新一轮',
            },
          ],
          timestamp: 1_001,
        },
      ],
    })
    expect(rows.map((row) => row.messageId)).toEqual(['user:c-opt'])
    expect(rows[0]?.payload.text).toBe('开始新一轮')
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

  it('does not prepend a msg-* user echo beside live user:<clientSubmitId>', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'hist-u0',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: '旧问题' },
        occurredAtUnixMs: 1,
      },
      {
        ...base,
        messageId: 'assistant:run-old',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '旧回复' },
        occurredAtUnixMs: 2,
      },
      {
        ...base,
        messageId: 'msg-echo',
        turnId: 'turn-msg',
        role: 'user',
        kind: 'text',
        sequence: 3,
        version: 3,
        payload: { text: '开始新一轮' },
        occurredAtUnixMs: 3,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'hist-u0',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: '旧问题' },
        occurredAtUnixMs: 1,
      },
      {
        ...base,
        messageId: 'assistant:run-old',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '旧回复' },
        occurredAtUnixMs: 2,
      },
      {
        ...base,
        messageId: 'user:c-new',
        turnId: 'turn-c-new',
        role: 'user',
        kind: 'text',
        sequence: 3,
        version: 3,
        payload: { text: '开始新一轮', clientSubmitId: 'c-new' },
        occurredAtUnixMs: 3,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    const users = merged.filter((row) => row.role === 'user')
    expect(users.map((row) => row.messageId)).toEqual([
      'hist-u0',
      'user:c-new',
    ])
    expect(users.filter((row) => row.payload.text === '开始新一轮')).toHaveLength(
      1,
    )
  })

  it('stamps history user:<clientSubmitId> onto live by id (no text needed)', () => {
    const history = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 's',
      messages: [
        {
          id: 'user:c-same',
          role: 'user',
          clientSubmitId: 'c-same',
          content: [
            {
              type: 'text',
              text: '[Workspace::v1: /tmp/proj]\nhistory body only',
            },
          ],
          timestamp: 3,
        },
      ],
    })
    expect(history[0]?.messageId).toBe('user:c-same')
    expect(history[0]?.payload.text).toBe('history body only')
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:c-same',
        turnId: 'turn-c-same',
        role: 'user',
        kind: 'text',
        payload: {
          text: 'live optimistic body',
          clientSubmitId: 'c-same',
        },
        occurredAtUnixMs: 3,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    // Shared submit/messageId pairs even when bodies differ.
    expect(merged.map((row) => row.messageId)).toEqual(['user:c-same'])
  })

  it('pairs Workspace-prefixed gateway history onto bare live user via mapping', () => {
    // Prove the write/read identity fix: mapping strips the transport
    // envelope so ordinal/same-prompt pairing stamps one user — not merge
    // echo-skip as a display patch.
    const history = hermesHistoryMessagesToActivity({
      workspaceId: 'ws',
      agentSessionId: 's',
      messages: [
        {
          id: 'msg-echo',
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Workspace::v1: /tmp/proj]\n开始新一轮',
            },
          ],
          timestamp: 3,
        },
        {
          id: 'msg-a',
          role: 'assistant',
          content: [{ type: 'text', text: '好的' }],
          timestamp: 4,
        },
      ],
    })
    expect(history[0]?.payload.text).toBe('开始新一轮')
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:c-new',
        turnId: 'turn-c-new',
        role: 'user',
        kind: 'text',
        payload: { text: '开始新一轮', clientSubmitId: 'c-new' },
        occurredAtUnixMs: 3,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    const users = merged.filter((row) => row.role === 'user')
    expect(users.map((row) => row.messageId)).toEqual(['user:c-new'])
    expect(users).toHaveLength(1)
  })

  it('does not ordinal-pair two assistant-bearing turns without shared submit', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'hist-u1',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: '旧问题' },
        occurredAtUnixMs: 1_000,
      },
      {
        ...base,
        messageId: 'assistant:run-old',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '很长的上一条回复……要我继续钉死吗？' },
        occurredAtUnixMs: 1_100,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:c-new',
        turnId: 'turn-c-new',
        role: 'user',
        kind: 'text',
        payload: { text: '现在是哪个模型', clientSubmitId: 'c-new' },
        occurredAtUnixMs: 2_000,
      },
      {
        ...base,
        messageId: 'assistant:run-new',
        turnId: 'turn-c-new',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '这次生效了。现在跑的是 DeepSeek-V4-Flash' },
        occurredAtUnixMs: 2_100,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'hist-u1',
      'assistant:run-old',
      'user:c-new',
      'assistant:run-new',
    ])
    expect(
      merged.find((row) => row.messageId === 'assistant:run-new')?.payload.text,
    ).toBe('这次生效了。现在跑的是 DeepSeek-V4-Flash')
  })

  it('does not relocate a prior history assistant under a new open user', () => {
    const history: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'hist-u1',
        turnId: 'turn-old',
        role: 'user',
        kind: 'text',
        payload: { text: '旧问题' },
        occurredAtUnixMs: 1_000,
      },
      {
        ...base,
        messageId: 'assistant:run-old',
        turnId: 'turn-old',
        role: 'assistant',
        kind: 'text',
        sequence: 2,
        version: 2,
        payload: { text: '旧回复：官方 Skill 是上游最小起点' },
        occurredAtUnixMs: 1_100,
      },
    ]
    const live: AgentActivityDurableMessage[] = [
      {
        ...base,
        messageId: 'user:c-new',
        turnId: 'turn-c-new',
        role: 'user',
        kind: 'text',
        payload: {
          text: '开始新一轮长回复',
          clientSubmitId: 'c-new',
        },
        occurredAtUnixMs: 2_000,
      },
    ]
    const merged = mergeHermesHistoryWithLiveByTurnIdentity({
      workspaceId: 'ws',
      agentSessionId: 's',
      history,
      live,
    })
    expect(merged.map((row) => row.messageId)).toEqual([
      'hist-u1',
      'assistant:run-old',
      'user:c-new',
    ])
    // Prior assistant must stay above the new user — not grafted under it.
    const newUserIndex = merged.findIndex((row) => row.messageId === 'user:c-new')
    const oldAsstIndex = merged.findIndex(
      (row) => row.messageId === 'assistant:run-old',
    )
    expect(oldAsstIndex).toBeLessThan(newUserIndex)
  })
})
