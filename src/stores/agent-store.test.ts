import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from './agent-store'
import type { AgentSession } from '@/lib/agent-types'

function session(agentId: string, sessionId: string): AgentSession {
  return {
    sessionId,
    agentId,
    state: 'idle',
    title: sessionId,
    lastMessageAt: new Date().toISOString(),
  }
}

describe('agent-store Agorax-style session memory', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: [],
      agentsLoading: false,
      agentsError: null,
      activeAgentId: null,
      sessionsByAgentId: new Map(),
      sessionsLoading: new Set(),
      activeSessionId: null,
      lastActiveSessionIdByAgentId: {},
    })
  })

  it('remembers the previous agent session when switching and restores it on return', () => {
    const store = useAgentStore.getState()
    store.setSessions('cursor-impl', [session('cursor-impl', 'cursor-s1')])
    store.setSessions('cc-impl', [session('cc-impl', 'cc-s1')])

    store.setActiveAgentId('cursor-impl', { sessionId: 'cursor-s1' })
    expect(useAgentStore.getState().activeSessionId).toBe('cursor-s1')

    store.setActiveAgentId('cc-impl', { sessionId: 'cc-s1' })
    expect(useAgentStore.getState().activeSessionId).toBe('cc-s1')
    expect(
      useAgentStore.getState().lastActiveSessionIdByAgentId['cursor-impl'],
    ).toBe('cursor-s1')

    // Switch back without an explicit session — restore from memory.
    store.setActiveAgentId('cursor-impl')
    expect(useAgentStore.getState().activeSessionId).toBe('cursor-s1')
  })

  it('does not keep a foreign session selected when landing on an empty agent', () => {
    const store = useAgentStore.getState()
    store.setSessions('kimi-impl', [session('kimi-impl', 'kimi-s1')])
    store.setSessions('cursor-impl', [])
    store.setActiveAgentId('kimi-impl', { sessionId: 'kimi-s1' })

    store.setActiveAgentId('cursor-impl', { sessionId: null })
    expect(useAgentStore.getState().activeAgentId).toBe('cursor-impl')
    expect(useAgentStore.getState().activeSessionId).toBeNull()
    expect(
      useAgentStore.getState().lastActiveSessionIdByAgentId['kimi-impl'],
    ).toBe('kimi-s1')
  })

  it('keeps per-agent memory across New Chat', () => {
    const store = useAgentStore.getState()
    store.setActiveAgentId('codex-impl', { sessionId: 'codex-s1' })
    store.setActiveSessionId(null)
    expect(useAgentStore.getState().activeSessionId).toBeNull()
    expect(
      useAgentStore.getState().lastActiveSessionIdByAgentId['codex-impl'],
    ).toBe('codex-s1')
  })
})
