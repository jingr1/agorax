// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExternalAgentSessions } from './use-external-agent-sessions'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), rename: vi.fn(), delete: vi.fn(),
  setSessions: vi.fn(), upsertSession: vi.fn(), removeSession: vi.fn(),
  setSessionsLoading: vi.fn(), setActiveSessionId: vi.fn(),
  sessions: new Map(), loading: new Set(),
}))

vi.mock('@/lib/agent-api', () => ({
  fetchSessionsForAgent: mocks.fetch,
  renameManagedSession: mocks.rename,
  deleteManagedSession: mocks.delete,
}))
vi.mock('@/stores/agent-store', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({
    activeSessionId: 'session-1',
    setActiveSessionId: mocks.setActiveSessionId,
    sessionsByAgentId: mocks.sessions,
    setSessions: mocks.setSessions,
    upsertSession: mocks.upsertSession,
    removeSession: mocks.removeSession,
    setSessionsLoading: mocks.setSessionsLoading,
    sessionsLoading: mocks.loading,
  }),
}))

describe('managed session failures', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.sessions.set('agent-1', [{
      sessionId: 'session-1', title: 'Cached chat', lastMessageAt: '2026-10-29',
    }])
  })
  afterEach(cleanup)

  it('preserves cached sessions on failure and clears the error after retry', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('Daemon offline'))
    const { result } = renderHook(() => useExternalAgentSessions('agent-1'))
    await waitFor(() => expect(result.current.error).toBe('Daemon offline'))
    expect(result.current.sessions[0].title).toBe('Cached chat')
    expect(mocks.setSessions).not.toHaveBeenCalled()
    mocks.fetch.mockResolvedValueOnce({ sessions: [] })
    act(() => result.current.onRetry())
    await waitFor(() => expect(mocks.setSessions).toHaveBeenCalledWith('agent-1', []))
    expect(result.current.error).toBeNull()
  })

  it.each(['rename', 'delete'] as const)('reports %s failures without mutating sessions', async (operation) => {
    mocks.fetch.mockResolvedValue({ sessions: [] })
    mocks[operation].mockRejectedValue(new Error(`${operation} failed`))
    const { result } = renderHook(() => useExternalAgentSessions('agent-1'))
    await waitFor(() => expect(mocks.setSessions).toHaveBeenCalled())
    act(() => {
      const session = result.current.sessions[0]
      if (operation === 'rename') result.current.onRename?.(session, 'New title')
      else result.current.onDelete?.(session)
    })
    await waitFor(() => expect(result.current.error).toBe(`${operation} failed`))
    expect(mocks.upsertSession).not.toHaveBeenCalled()
    expect(mocks.removeSession).not.toHaveBeenCalled()
  })
})