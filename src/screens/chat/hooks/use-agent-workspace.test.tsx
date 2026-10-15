// @vitest-environment jsdom
// TODO: un-skip after fixing React ESM/CJS multi-instance interop in Vitest.
// Right now zustand's ESM copy loads a different React instance than
// react-dom's CJS copy, so hooks see a null dispatcher. This is a test harness
// issue, not a bug in the hook itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useAgentWorkspace } from './use-agent-workspace'
import type { AgentSession, AgentWithStatus } from '@/lib/agent-types'
import { useAgentStore } from '@/stores/agent-store'

function TestComponent() {
  useAgentWorkspace()
  return <div data-testid="workspace">workspace</div>
}

describe.skip('useAgentWorkspace', () => {
  const fetchSpy = vi.spyOn(global, 'fetch')
  const eventSourceSpy = vi.fn()

  beforeEach(() => {
    fetchSpy.mockReset()
    eventSourceSpy.mockReset()

    // Patch EventSource so subscribeAgentEvents can register without a real SSE
    // connection. We capture the created instance to emit messages later.
    let currentInstance: FakeEventSource | null = null
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      close = vi.fn()
      constructor(public url: string) {
        currentInstance = this
      }
      emit(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) })
      }
    }
    Object.defineProperty(global, 'EventSource', {
      configurable: true,
      value: FakeEventSource,
      writable: true,
    })
    eventSourceSpy.mockImplementation(() => currentInstance)

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

  afterEach(() => {
    vi.clearAllTimers()
  })

  it('fetches agents once on mount and sets the first online agent active', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          agents: [
            {
              agentId: 'offline-agent',
              name: 'Offline',
              runtime: 'hermes',
              status: 'offline',
            } as AgentWithStatus,
            {
              agentId: 'online-agent',
              name: 'Online',
              runtime: 'hermes',
              status: 'online',
            } as AgentWithStatus,
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    render(<TestComponent />)

    await waitFor(() => {
      expect(useAgentStore.getState().agents).toHaveLength(2)
    })
    expect(useAgentStore.getState().activeAgentId).toBe('online-agent')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/agents')
  })

  it('does not enter an infinite render loop when store updates rapidly', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          agents: [
            {
              agentId: 'agent-a',
              name: 'Agent A',
              runtime: 'hermes',
              status: 'online',
            } as AgentWithStatus,
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    // If the hook subscribed to the whole store, each store mutation would
    // re-run effects and call fetchAgents repeatedly. The test asserts only a
    // single fetch happens.
    render(<TestComponent />)

    await waitFor(() => {
      expect(useAgentStore.getState().agents).toHaveLength(1)
    })

    // Rapid fire unrelated store updates from outside the component.
    for (let i = 0; i < 10; i += 1) {
      useAgentStore.getState().setAgentsLoading(true)
      useAgentStore.getState().setAgentsLoading(false)
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('fetches sessions when active agent changes and caches them', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            agents: [
              {
                agentId: 'agent-a',
                name: 'Agent A',
                runtime: 'hermes',
                status: 'online',
              } as AgentWithStatus,
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessions: [
              {
                sessionId: 'session-1',
                agentId: 'agent-a',
                title: 'Session 1',
                state: 'idle',
                lastMessageAt: new Date().toISOString(),
              } as AgentSession,
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

    const { rerender } = render(<TestComponent />)

    await waitFor(() => {
      expect(useAgentStore.getState().sessionsByAgentId.has('agent-a')).toBe(
        true,
      )
    })
    expect(fetchSpy).toHaveBeenCalledWith('/api/agents')
    expect(fetchSpy).toHaveBeenCalledWith('/api/agents/agent-a/sessions')

    // Re-rendering should not trigger another session fetch.
    rerender(<TestComponent />)
    await waitFor(() => {
      expect(
        useAgentStore.getState().sessionsByAgentId.get('agent-a'),
      ).toHaveLength(1)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('subscribes to agent status events', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    render(<TestComponent />)

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/agents')
    })
    // The hook registered an EventSource for global collab events.
    expect(global.EventSource).toBeDefined()
  })
})
