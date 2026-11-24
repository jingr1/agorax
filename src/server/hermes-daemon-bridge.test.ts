import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  daemonActivityToChatHistory,
  hermesDaemonWorkspaceId,
  persistHermesTurnToDaemon,
} from './hermes-daemon-bridge'
import type { AgentActivityDurableMessage } from '@agorax/agent-activity-core'

describe('hermes daemon bridge', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('maps profile to hermes workspace id', () => {
    expect(hermesDaemonWorkspaceId('developer')).toBe('hermes:developer')
    expect(hermesDaemonWorkspaceId('')).toBe('hermes:default')
  })

  it('no-ops when AGORAX_MANAGED_AGENT_URL is unset', async () => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', '')
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(
      persistHermesTurnToDaemon({
        agentSessionId: 'sess',
        clientSubmitId: 'c1',
        userText: 'hi',
      }),
    ).resolves.toEqual({ ok: false, latestVersion: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('POSTs strong-id activity to hermes-bridge', async () => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', 'http://127.0.0.1:8788')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latestVersion: 42 }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchImpl)

    await expect(
      persistHermesTurnToDaemon({
        agentSessionId: 'sess-1',
        profileName: 'default',
        clientSubmitId: 'submit-1',
        userText: '继续',
        hermesRunId: 'run-1',
        assistantText: '收到',
        status: 'completed',
        settled: true,
      }),
    ).resolves.toEqual({ ok: true, latestVersion: 42 })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain(
      '/v1/workspaces/hermes%3Adefault/hermes-bridge/sessions/sess-1/activity',
    )
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.turnId).toBe('turn-submit-1')
    expect(body.phase).toBe('settled')
    expect(body.messages.map((m: { messageId: string }) => m.messageId)).toEqual(
      ['user:submit-1', 'assistant:run-1'],
    )
  })

  it('projects daemon activity to chat history without msg-N', () => {
    const messages = [
      {
        messageId: 'user:s1',
        role: 'user',
        kind: 'text',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 1,
        version: 1,
        payload: { text: 'hi', clientSubmitId: 's1' },
        occurredAtUnixMs: 1,
      },
      {
        messageId: 'assistant:r1',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 2,
        version: 2,
        payload: { text: 'yo' },
        occurredAtUnixMs: 2,
      },
    ] as AgentActivityDurableMessage[]
    const chat = daemonActivityToChatHistory(messages)
    expect(chat.map((m) => m.id)).toEqual(['user:s1', 'assistant:r1'])
  })

  it('skips empty streaming workspace shells so prior reply stays intact', () => {
    const messages = [
      {
        messageId: 'user:t1',
        role: 'user',
        kind: 'text',
        turnId: 'turn-t1',
        status: 'completed',
        sequence: 1,
        version: 1,
        payload: { text: '你好吗？', clientSubmitId: 't1' },
        occurredAtUnixMs: 1,
      },
      {
        messageId: 'assistant:05d59493-0587-4d2c-a6eb-dc04049c2bf8',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-t1',
        status: 'streaming',
        sequence: 2,
        version: 2,
        payload: { text: '', clientSubmitId: 't1' },
        occurredAtUnixMs: 2,
      },
      {
        messageId: 'assistant:run_fc5edeb77de847aa842b6ae3ca049182',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-t1',
        status: 'completed',
        sequence: 3,
        version: 3,
        payload: { text: '好。', clientSubmitId: 't1' },
        occurredAtUnixMs: 3,
      },
      {
        messageId: 'user:t2',
        role: 'user',
        kind: 'text',
        turnId: 'turn-t2',
        status: 'completed',
        sequence: 4,
        version: 4,
        payload: { text: '在干嘛？', clientSubmitId: 't2' },
        occurredAtUnixMs: 4,
      },
      {
        messageId: 'assistant:run_8994f685ce644ecdba072795e3b6f0aa',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-t2',
        status: 'completed',
        sequence: 5,
        version: 5,
        payload: { text: '等你的下一步指令。', clientSubmitId: 't2' },
        occurredAtUnixMs: 5,
      },
    ] as AgentActivityDurableMessage[]
    const chat = daemonActivityToChatHistory(messages)
    expect(chat.map((m) => m.id)).toEqual([
      'user:t1',
      'assistant:run_fc5edeb77de847aa842b6ae3ca049182',
      'user:t2',
      'assistant:run_8994f685ce644ecdba072795e3b6f0aa',
    ])
    expect(chat[1]?.text).toBe('好。')
    expect(chat[3]?.text).toBe('等你的下一步指令。')
  })

  it('folds same-turn text-then-reasoning into one host (reasoning kept as-is)', () => {
    const reply = '你好！有什么我可以帮你的吗？'
    const messages = [
      {
        messageId: 'user:s1',
        role: 'user',
        kind: 'text',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 1,
        version: 1,
        payload: { text: 'hi', clientSubmitId: 's1' },
        occurredAtUnixMs: 1,
      },
      {
        messageId: 'assistant:r1',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 2,
        version: 2,
        payload: { text: reply },
        occurredAtUnixMs: 2,
      },
      {
        messageId: 'assistant:r1:thinking',
        role: 'assistant',
        kind: 'reasoning',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 3,
        version: 3,
        payload: { text: reply },
        occurredAtUnixMs: 3,
      },
    ] as AgentActivityDurableMessage[]
    const chat = daemonActivityToChatHistory(messages)
    expect(chat.map((m) => m.id)).toEqual(['user:s1', 'assistant:r1'])
    expect(chat[1]?.content).toEqual([
      { type: 'thinking', thinking: reply },
      { type: 'text', text: reply },
    ])
    expect(chat[1]?.text).toBe(reply)
  })

  it('keeps thinking above text on the same host', () => {
    const messages = [
      {
        messageId: 'user:s1',
        role: 'user',
        kind: 'text',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 1,
        version: 1,
        payload: { text: 'hi', clientSubmitId: 's1' },
        occurredAtUnixMs: 1,
      },
      {
        messageId: 'assistant:r1:thinking',
        role: 'assistant',
        kind: 'reasoning',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 2,
        version: 2,
        payload: { text: '用户在打招呼，礼貌回应即可。' },
        occurredAtUnixMs: 2,
      },
      {
        messageId: 'assistant:r1',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-s1',
        status: 'completed',
        sequence: 3,
        version: 3,
        payload: { text: '你好！有什么我可以帮你的吗？' },
        occurredAtUnixMs: 3,
      },
    ] as AgentActivityDurableMessage[]
    const chat = daemonActivityToChatHistory(messages)
    expect(chat).toHaveLength(2)
    expect(chat[1]?.content).toEqual([
      { type: 'thinking', thinking: '用户在打招呼，礼貌回应即可。' },
      { type: 'text', text: '你好！有什么我可以帮你的吗？' },
    ])
  })

  it('persists thinking before text without content filtering', async () => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', 'http://127.0.0.1:8788')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latestVersion: 3 }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchImpl)
    const reply = '你好！有什么我可以帮你的吗？'
    await persistHermesTurnToDaemon({
      agentSessionId: 'sess-1',
      clientSubmitId: 'submit-1',
      hermesRunId: 'run-1',
      assistantText: reply,
      thinkingText: reply,
      settled: true,
      status: 'completed',
    })
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))
    expect(body.messages.map((m: { messageId: string }) => m.messageId)).toEqual(
      ['assistant:run-1:thinking', 'assistant:run-1'],
    )
  })

  it('persists toolcall rows and folds them into daemon history hosts', async () => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', 'http://127.0.0.1:8788')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latestVersion: 4 }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchImpl)
    await persistHermesTurnToDaemon({
      agentSessionId: 'sess-1',
      clientSubmitId: 'submit-1',
      hermesRunId: 'run-tools',
      assistantText: 'done',
      thinkingText: 'use web',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'web_search',
          phase: 'complete',
          args: { q: 'x' },
          result: 'hits',
        },
      ],
      settled: true,
      status: 'completed',
    })
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]![1] as RequestInit).body),
    )
    expect(body.messages.map((m: { messageId: string }) => m.messageId)).toEqual(
      [
        'assistant:run-tools:thinking',
        'assistant:run-tools',
        'toolcall:tc-1',
      ],
    )

    const chat = daemonActivityToChatHistory([
      {
        messageId: 'assistant:run-tools:thinking',
        role: 'assistant',
        kind: 'reasoning',
        turnId: 'turn-submit-1',
        status: 'completed',
        sequence: 1,
        version: 1,
        payload: { text: 'use web', runId: 'run-tools' },
        occurredAtUnixMs: 1,
      },
      {
        messageId: 'toolcall:tc-1',
        role: 'assistant',
        kind: 'tool_call',
        turnId: 'turn-submit-1',
        status: 'completed',
        sequence: 2,
        version: 2,
        payload: {
          name: 'web_search',
          toolName: 'web_search',
          phase: 'complete',
          input: { q: 'x' },
          output: 'hits',
          runId: 'run-tools',
        },
        occurredAtUnixMs: 2,
      },
      {
        messageId: 'assistant:run-tools',
        role: 'assistant',
        kind: 'text',
        turnId: 'turn-submit-1',
        status: 'completed',
        sequence: 3,
        version: 3,
        payload: { text: 'done', runId: 'run-tools' },
        occurredAtUnixMs: 3,
      },
    ] as AgentActivityDurableMessage[])
    expect(chat).toHaveLength(1)
    expect(chat[0]?.content).toEqual([
      { type: 'thinking', thinking: 'use web' },
      {
        type: 'toolCall',
        id: 'tc-1',
        name: 'web_search',
        arguments: { q: 'x' },
        result: 'hits',
      },
      { type: 'text', text: 'done' },
    ])
  })
})
