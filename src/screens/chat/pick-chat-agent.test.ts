// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { pickChatAgentId } from './pick-chat-agent'

describe('pickChatAgentId', () => {
  const agents = [
    { agentId: 'offline', status: 'offline' },
    { agentId: 'default', status: 'online' },
    { agentId: 'cc-impl', status: 'busy' },
  ]

  it('returns null for an empty registry', () => {
    expect(pickChatAgentId([])).toBeNull()
    expect(pickChatAgentId([], 'default')).toBeNull()
  })

  it('prefers a remembered id when it still exists', () => {
    expect(pickChatAgentId(agents, 'cc-impl')).toBe('cc-impl')
    expect(pickChatAgentId(agents, '  default  ')).toBe('default')
  })

  it('ignores a stale remembered id and picks online/busy', () => {
    expect(pickChatAgentId(agents, 'deleted-agent')).toBe('default')
    expect(pickChatAgentId(agents, null)).toBe('default')
  })

  it('falls back to the first listed agent when none are online', () => {
    expect(
      pickChatAgentId([
        { agentId: 'a', status: 'offline' },
        { agentId: 'b', status: 'offline' },
      ]),
    ).toBe('a')
  })
})
