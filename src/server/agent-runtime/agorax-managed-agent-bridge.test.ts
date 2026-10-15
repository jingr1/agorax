import { describe, expect, it, vi } from 'vitest'
import {
  isAgoraxManagedAgentBackend,
  AGORAX_MANAGED_AGENT_BACKENDS,
  AgoraxManagedAgentBridge,
  type AgoraxManagedAgentTransport,
} from './agorax-managed-agent-bridge'

describe('AgoraxManagedAgentBridge', () => {
  it('only exposes the Agorax managed backend set', () => {
    expect(AGORAX_MANAGED_AGENT_BACKENDS).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'opencode',
      'kimi',
    ])
    expect(isAgoraxManagedAgentBackend('cursor')).toBe(true)
    expect(isAgoraxManagedAgentBackend('foreign-agent')).toBe(false)
    expect(isAgoraxManagedAgentBackend('hermes')).toBe(false)
  })

  it('delegates lifecycle operations without creating local state', async () => {
    const events = [{ type: 'run_started', runId: 'run-1', agentId: 'agent-1' }]
    const transport: AgoraxManagedAgentTransport = {
      probe: vi.fn().mockResolvedValue({ available: true }),
      startRun: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      streamEvents: vi.fn().mockReturnValue((async function* () {
        yield events[0]
      })()),
      interrupt: vi.fn().mockResolvedValue(undefined),
    }
    const bridge = new AgoraxManagedAgentBridge('cursor', transport)
    const run = {
      runId: 'run-1',
      agentId: 'agent-1',
      task: 'inspect the workspace',
    }
    const mcp = {
      endpoint: 'http://127.0.0.1:3001/api/mcp-rpc',
      runToken: 'test-token',
      toolAllowlist: [],
    }

    await expect(bridge.probe()).resolves.toEqual({ available: true })
    await expect(bridge.probe()).resolves.toEqual({ available: true })
    expect(transport.probe).toHaveBeenCalledTimes(1)

    await expect(bridge.startRun({ ...run, mcp })).resolves.toEqual({ runId: 'run-1' })
    await expect([...await collect(bridge.streamEvents('run-1'))]).toEqual(events)
    await expect(bridge.interrupt('run-1', 'user_requested')).resolves.toBeUndefined()

    expect(transport.startRun).toHaveBeenCalledWith({ backend: 'cursor', run, mcp })
    expect(transport.interrupt).toHaveBeenCalledWith({
      backend: 'cursor',
      runId: 'run-1',
      reason: 'user_requested',
    })
  })
})

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const item of items) collected.push(item)
  return collected
}