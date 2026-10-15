import { describe, expect, it, vi } from 'vitest'
import { runManagedTurn } from './run-managed-turn'
import type { AgentRuntimeAdapter } from './types'

vi.mock('./router', () => ({
  getAgentRuntimeRouter: () => ({
    getAdapter: (agentId: string) => {
      if (agentId !== 'cc-impl') return null
      return mockAdapter
    },
  }),
}))

vi.mock('../collab-db', () => ({
  createCollabId: () => 'run_test_1',
}))

vi.mock('../mcp/run-tokens', () => ({
  issueRunToken: () => ({ token: 'tok' }),
}))

vi.mock('./dispatch', () => ({
  getMcpEndpoint: () => 'http://127.0.0.1:9/mcp',
}))

const mockAdapter: AgentRuntimeAdapter = {
  kind: 'claude-code',
  agentId: 'cc-impl',
  probe: vi.fn(),
  startRun: vi.fn().mockResolvedValue({ runId: 'run_test_1' }),
  streamEvents: vi.fn(),
  interrupt: vi.fn().mockResolvedValue(undefined),
}

describe('runManagedTurn activity reconcile', () => {
  it('surfaces quota error from activity poll when WS never exits', async () => {
    mockAdapter.streamEvents = vi.fn().mockReturnValue(
      (async function* () {
        // Never yields run_exited — simulates dropped terminal WS frame.
        await new Promise(() => undefined)
      })(),
    )

    const result = await runManagedTurn({
      agentId: 'cc-impl',
      task: 'hi',
      softTimeoutMs: 5_000,
      hardCapMs: 10_000,
      pollMs: 20,
      reconcileActivity: vi.fn().mockResolvedValue({
        settled: true,
        text: '',
        error: 'You’ve hit your usage limit.',
        outcome: 'failed',
        exitCode: 1,
      }),
    })

    expect(result).toEqual({
      kind: 'failed',
      runId: 'run_test_1',
      reason: 'You’ve hit your usage limit.',
      events: [],
    })
    expect(mockAdapter.interrupt).toHaveBeenCalled()
  })

  it('on empty soft timeout, reconciles activity before reporting empty', async () => {
    mockAdapter.streamEvents = vi.fn().mockReturnValue(
      (async function* () {
        await new Promise(() => undefined)
      })(),
    )
    mockAdapter.interrupt = vi.fn().mockResolvedValue(undefined)
    const reconcileActivity = vi.fn().mockImplementation(() => {
      // Soft-timeout path interrupts before the empty-failure reconcile.
      const afterTimeout = (mockAdapter.interrupt as ReturnType<typeof vi.fn>).mock
        .calls.some((args) => String(args[1] ?? '').includes('timeout'))
      return Promise.resolve(
        afterTimeout
          ? {
              settled: true,
              text: 'late assistant text',
              error: null,
              outcome: 'completed',
              exitCode: 0,
            }
          : {
              settled: false,
              text: '',
              error: null,
              outcome: null,
              exitCode: null,
            },
      )
    })

    const result = await runManagedTurn({
      agentId: 'cc-impl',
      task: 'hi',
      softTimeoutMs: 50,
      hardCapMs: 200,
      pollMs: 20,
      reconcileActivity,
    })

    expect(result).toEqual({
      kind: 'timed_out',
      runId: 'run_test_1',
      text: 'late assistant text',
      events: [],
    })
  })
})
