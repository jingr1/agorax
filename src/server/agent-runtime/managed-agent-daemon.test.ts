import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn,
  default: { spawn },
}))

import { ensureManagedAgentDaemon } from './managed-agent-daemon'

beforeEach(() => {
  spawn.mockReset()
  vi.unstubAllGlobals()
  delete process.env.AGORAX_MANAGED_AGENT_URL
  delete process.env.AGORAX_MANAGED_AGENT_PORT
})

describe('ensureManagedAgentDaemon', () => {
  it('leaves a healthy daemon running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true }),
    )

    const result = await ensureManagedAgentDaemon()

    expect(result).toEqual({
      ok: true,
      healthy: true,
      detail: 'already healthy at http://127.0.0.1:8788',
    })
    expect(spawn).not.toHaveBeenCalled()
  })
})
