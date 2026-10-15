// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { canPaintChatAgentShell } from './$agentId'
import { useAgentStore } from '@/stores/agent-store'
import type { AgentWithStatus } from '@/lib/agent-types'

describe('canPaintChatAgentShell', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: [],
      activeAgentId: null,
      activeSessionId: null,
    })
  })

  it('is false on cold entry with an empty registry', () => {
    expect(canPaintChatAgentShell()).toBe(false)
  })

  it('is true once agents are seeded so agent switches keep the shell', () => {
    useAgentStore.getState().setAgents([
      {
        agentId: 'default',
        name: 'Default',
        runtime: 'hermes',
        status: 'online',
        runtimeConfig: { profile: 'default' },
      } as AgentWithStatus,
    ])
    expect(canPaintChatAgentShell()).toBe(true)
  })
})
