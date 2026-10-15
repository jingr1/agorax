import { describe, expect, it, vi } from 'vitest'

vi.mock('./router', () => ({
  getAgentRuntimeRouter: () => ({
    registry: {
      byId: new Map([
        ['cc-impl', { id: 'cc-impl', runtime: 'claude-code' }],
        ['cursor-impl', { id: 'cursor-impl', runtime: 'cursor' }],
      ]),
    },
  }),
}))

import { resolveAgoraxManagedSessionIdentity } from './agorax-managed-agent-session-identity'
import type { AgoraxManagedRunStore } from './agorax-managed-run-store'

describe('resolveAgoraxManagedSessionIdentity', () => {
  it('rejects a display binding that belongs to another backend', async () => {
    const runStore = {
      getByDisplaySession: vi.fn(async () => ({
        backend: 'codex',
        agentSessionId: 'daemon-s1',
      })),
      get: vi.fn(async () => null),
    } as unknown as AgoraxManagedRunStore

    await expect(
      resolveAgoraxManagedSessionIdentity({
        agentId: 'cursor-impl',
        sessionId: 'display-s1',
        runStore,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'session does not belong to this agent',
    })
  })

  it('accepts a matching display binding', async () => {
    const runStore = {
      getByDisplaySession: vi.fn(async () => ({
        backend: 'claude-code',
        agentSessionId: 'daemon-cc-1',
      })),
      get: vi.fn(async () => null),
    } as unknown as AgoraxManagedRunStore

    await expect(
      resolveAgoraxManagedSessionIdentity({
        agentId: 'cc-impl',
        sessionId: 'display-cc',
        runStore,
      }),
    ).resolves.toEqual({
      ok: true,
      backend: 'claude-code',
      agentSessionId: 'daemon-cc-1',
    })
  })
})
