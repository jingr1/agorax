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
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('POSTs strong-id activity to hermes-bridge', async () => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', 'http://127.0.0.1:8788')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
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
    ).resolves.toBe(true)

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
})
