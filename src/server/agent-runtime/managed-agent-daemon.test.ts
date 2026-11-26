import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureManagedAgentDaemon,
  isManagedAgentDaemonBinaryStale,
} from './managed-agent-daemon'

beforeEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AGORAX_MANAGED_AGENT_URL
  delete process.env.AGORAX_MANAGED_AGENT_PORT
})

describe('isManagedAgentDaemonBinaryStale', () => {
  it('is false when the on-disk binary is missing', async () => {
    const stale = await isManagedAgentDaemonBinaryStale({
      binaryPath: '/tmp/missing-agorax-agentd',
      port: '8788',
      binaryMtimeMs: async () => null,
      listListenerPids: async () => [1],
    })
    expect(stale).toBe(false)
  })

  it('is true when binary mtime is newer than the listener process', async () => {
    const stale = await isManagedAgentDaemonBinaryStale({
      binaryPath: '/repo/.agorax/agorax-agentd',
      port: '8788',
      binaryMtimeMs: async () => 2_000,
      listListenerPids: async () => [42],
      processArgs: async () => '/repo/.agorax/agorax-agentd',
      processStartMs: async () => 1_000,
      exeLink: async () => '/repo/.agorax/agorax-agentd',
    })
    expect(stale).toBe(true)
  })

  it('is true when the listener was started from another checkout path', async () => {
    const stale = await isManagedAgentDaemonBinaryStale({
      binaryPath: '/repo/.agorax/agorax-agentd',
      port: '8788',
      binaryMtimeMs: async () => 1_000,
      listListenerPids: async () => [42],
      processArgs: async () => '/other/.agorax/agorax-agentd',
      processStartMs: async () => 2_000,
      exeLink: async () => '/other/.agorax/agorax-agentd',
    })
    expect(stale).toBe(true)
  })

  it('is true when /proc/pid/exe shows a replaced binary', async () => {
    const stale = await isManagedAgentDaemonBinaryStale({
      binaryPath: '/repo/.agorax/agorax-agentd',
      port: '8788',
      binaryMtimeMs: async () => 1_000,
      listListenerPids: async () => [42],
      processArgs: async () => '/repo/.agorax/agorax-agentd',
      processStartMs: async () => 2_000,
      exeLink: async () => '/repo/.agorax/agorax-agentd (deleted)',
    })
    expect(stale).toBe(true)
  })

  it('is false when the listener matches the current binary', async () => {
    const stale = await isManagedAgentDaemonBinaryStale({
      binaryPath: '/repo/.agorax/agorax-agentd',
      port: '8788',
      binaryMtimeMs: async () => 1_000,
      listListenerPids: async () => [42],
      processArgs: async () => '/repo/.agorax/agorax-agentd',
      processStartMs: async () => 2_000,
      exeLink: async () => '/repo/.agorax/agorax-agentd',
    })
    expect(stale).toBe(false)
  })
})

describe('ensureManagedAgentDaemon', () => {
  it('leaves a healthy daemon running when the binary is not stale', async () => {
    const restart = vi.fn()
    const result = await ensureManagedAgentDaemon({
      probeHealth: async () => true,
      binaryExists: async () => true,
      isBinaryStale: async () => false,
      restart,
    })

    expect(result).toEqual({
      ok: true,
      healthy: true,
      detail: 'already healthy at http://127.0.0.1:8788',
    })
    expect(restart).not.toHaveBeenCalled()
  })

  it('restarts a healthy daemon when the on-disk binary is newer', async () => {
    const restart = vi.fn().mockResolvedValue({
      ok: true,
      healthy: true,
      detail: 'restarted',
    })
    const result = await ensureManagedAgentDaemon({
      probeHealth: async () => true,
      binaryExists: async () => true,
      isBinaryStale: async () => true,
      restart,
    })

    expect(restart).toHaveBeenCalledOnce()
    expect(String(restart.mock.calls[0]?.[0] ?? '')).toContain(
      'is newer than listener',
    )
    expect(result).toEqual({
      ok: true,
      healthy: true,
      detail: 'restarted',
    })
  })

  it('starts the daemon when health is down', async () => {
    const restart = vi.fn().mockResolvedValue({
      ok: true,
      healthy: true,
      detail: 'started',
    })
    const result = await ensureManagedAgentDaemon({
      probeHealth: async () => false,
      restart,
    })

    expect(restart).toHaveBeenCalledWith()
    expect(result.detail).toBe('started')
  })
})
