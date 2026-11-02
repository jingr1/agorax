import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureManagedAgentDaemon } from './managed-agent-daemon'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn,
  default: { spawn },
}))

beforeEach(() => {
  spawn.mockReset()
  vi.unstubAllGlobals()
  delete process.env.AGORAX_MANAGED_AGENT_URL
  delete process.env.AGORAX_MANAGED_AGENT_PORT
  delete process.env.AGORAX_MANAGED_AGENT_TOKEN
})

describe('ensureManagedAgentDaemon', () => {
  it('leaves a healthy daemon running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const result = await ensureManagedAgentDaemon()

    expect(result).toEqual({
      ok: true,
      healthy: true,
      detail: 'already healthy at http://127.0.0.1:8788',
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('authenticates health probes when the daemon token is configured', async () => {
    process.env.AGORAX_MANAGED_AGENT_TOKEN = 'daemon-secret'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await ensureManagedAgentDaemon()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/health',
      expect.objectContaining({
        headers: { Authorization: 'Bearer daemon-secret' },
      }),
    )
  })
})
