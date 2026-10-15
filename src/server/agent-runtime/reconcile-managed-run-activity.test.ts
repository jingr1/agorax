import { describe, expect, it, vi } from 'vitest'
import { reconcileManagedRunActivity } from './reconcile-managed-run-activity'
import type { AgoraxManagedAgentHttpClient } from './agorax-managed-agent-http-client'
import type { AgoraxManagedRunStore } from './agorax-managed-run-store'

describe('reconcileManagedRunActivity', () => {
  it('returns null when binding is missing', async () => {
    const runStore = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as AgoraxManagedRunStore
    const client = {
      getSessionDetail: vi.fn(),
    } as unknown as AgoraxManagedAgentHttpClient

    await expect(
      reconcileManagedRunActivity('run-missing', { runStore, client }),
    ).resolves.toBeNull()
    expect(client.getSessionDetail).not.toHaveBeenCalled()
  })

  it('recovers turn error when WS missed terminal settle', async () => {
    const runStore = {
      get: vi.fn().mockResolvedValue({
        runId: 'run-1',
        agentSessionId: 'session-1',
        backend: 'codex',
        updatedAt: 1,
      }),
    } as unknown as AgoraxManagedRunStore
    const client = {
      getSessionDetail: vi.fn().mockResolvedValue({
        session: {
          latestTurn: {
            turnId: 'turn-1',
            phase: 'settled',
            outcome: 'failed',
            error: {
              code: 'quota_or_rate_limit',
              message:
                'You’ve hit your usage limit. Upgrade to Plus to continue using Codex.',
            },
            updatedAtUnixMs: 2,
          },
        },
        turns: [],
        messages: [],
      }),
    } as unknown as AgoraxManagedAgentHttpClient

    await expect(
      reconcileManagedRunActivity('run-1', { runStore, client }),
    ).resolves.toEqual({
      settled: true,
      text: '',
      error:
        'You’ve hit your usage limit. Upgrade to Plus to continue using Codex.',
      outcome: 'failed',
      exitCode: 1,
    })
  })

  it('recovers assistant text from durable messages', async () => {
    const runStore = {
      get: vi.fn().mockResolvedValue({
        runId: 'run-2',
        agentSessionId: 'session-2',
        backend: 'claude-code',
        updatedAt: 1,
      }),
    } as unknown as AgoraxManagedRunStore
    const client = {
      getSessionDetail: vi.fn().mockResolvedValue({
        session: {
          latestTurn: {
            turnId: 'turn-2',
            phase: 'settled',
            outcome: 'completed',
            error: null,
            updatedAtUnixMs: 2,
          },
        },
        turns: [],
        messages: [
          {
            turnId: 'turn-2',
            role: 'assistant',
            payload: { text: 'real agent output' },
          },
        ],
      }),
    } as unknown as AgoraxManagedAgentHttpClient

    await expect(
      reconcileManagedRunActivity('run-2', { runStore, client }),
    ).resolves.toEqual({
      settled: true,
      text: 'real agent output',
      error: null,
      outcome: 'completed',
      exitCode: 0,
    })
  })

  it('reports unsettled when turn is still running', async () => {
    const runStore = {
      get: vi.fn().mockResolvedValue({
        runId: 'run-3',
        agentSessionId: 'session-3',
        backend: 'claude-code',
        updatedAt: 1,
      }),
    } as unknown as AgoraxManagedRunStore
    const client = {
      getSessionDetail: vi.fn().mockResolvedValue({
        session: {
          latestTurn: {
            turnId: 'turn-3',
            phase: 'running',
            outcome: null,
            error: null,
            updatedAtUnixMs: 2,
          },
        },
        turns: [],
        messages: [],
      }),
    } as unknown as AgoraxManagedAgentHttpClient

    await expect(
      reconcileManagedRunActivity('run-3', { runStore, client }),
    ).resolves.toEqual({
      settled: false,
      text: '',
      error: null,
      outcome: null,
      exitCode: null,
    })
  })

  it('falls back to raw PascalCase activity when detail mapping throws', async () => {
    const runStore = {
      get: vi.fn().mockResolvedValue({
        runId: 'run-4',
        agentSessionId: 'session-4',
        backend: 'codex',
        updatedAt: 1,
      }),
    } as unknown as AgoraxManagedRunStore
    const client = {
      getSessionDetail: vi
        .fn()
        .mockRejectedValue(new Error('Daemon contract error: blank Origin')),
      getActivitySnapshot: vi.fn().mockResolvedValue({
        turns: [
          {
            TurnID: 'turn-4',
            Phase: 'settled',
            Outcome: 'failed',
            ErrorMessage:
              "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
            UpdatedAtUnixMS: 99,
          },
        ],
        messages: [],
      }),
    } as unknown as AgoraxManagedAgentHttpClient

    await expect(
      reconcileManagedRunActivity('run-4', { runStore, client }),
    ).resolves.toEqual({
      settled: true,
      text: '',
      error:
        "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      outcome: 'failed',
      exitCode: 1,
    })
  })
})
