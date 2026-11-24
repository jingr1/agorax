/**
 * Regression: empty Engine + requestSessionReconcile must not re-enter on
 * every snapshot (Maximum update depth when mapped Hermes history is empty).
 */
import { describe, expect, it } from 'vitest'
import { shouldRequestEmptySessionReconcile } from './use-hermes-engine-chat'

describe('shouldRequestEmptySessionReconcile', () => {
  it('requests once while live messages stay empty, then allows retry after fill', () => {
    let already: string | null = null
    const run = (sid: string, liveMessageCount: number) => {
      const gate = shouldRequestEmptySessionReconcile({
        workspaceId: 'default',
        agentSessionId: sid,
        liveMessageCount,
        alreadyRequestedFor: already,
      })
      already = gate.nextAlreadyRequestedFor
      return gate.request
    }

    expect(run('sess-1', 0)).toBe(true)
    expect(run('sess-1', 0)).toBe(false)
    expect(run('sess-1', 0)).toBe(false)

    expect(run('sess-1', 2)).toBe(false)
    expect(already).toBeNull()

    expect(run('sess-1', 0)).toBe(true)
    expect(run('sess-2', 0)).toBe(true)
    expect(run('sess-2', 0)).toBe(false)
  })

  it('re-requests after workspace profile correction with the same session id', () => {
    let already: string | null = null
    const run = (workspaceId: string, sid: string) => {
      const gate = shouldRequestEmptySessionReconcile({
        workspaceId,
        agentSessionId: sid,
        liveMessageCount: 0,
        alreadyRequestedFor: already,
      })
      already = gate.nextAlreadyRequestedFor
      return gate.request
    }

    expect(run('default', '2380d15b')).toBe(true)
    expect(run('default', '2380d15b')).toBe(false)
    expect(run('architect', '2380d15b')).toBe(true)
    expect(run('architect', '2380d15b')).toBe(false)
  })
})
