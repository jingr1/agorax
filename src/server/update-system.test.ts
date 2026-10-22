import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  remoteUrlMatches,
  scheduleWorkspaceUiRestart,
  updateAvailableFromDivergence,
} from './update-system'

describe('update-system helpers', () => {
  it('matches GitHub URL forms against expected repo aliases', () => {
    expect(
      remoteUrlMatches('https://github.com/jingr1/agorax.git', [
        'agorax',
        'jingr1/agorax',
      ]),
    ).toBe(true)
    expect(
      remoteUrlMatches('git@github.com:NousResearch/hermes-agent.git', [
        'hermes-agent',
      ]),
    ).toBe(true)
    expect(
      remoteUrlMatches('https://github.com/example/other.git', ['agorax']),
    ).toBe(false)
  })

  it('only reports update availability when the remote side is ahead', () => {
    expect(updateAvailableFromDivergence({ ahead: 2, behind: 0 }, true)).toBe(
      false,
    )
    expect(updateAvailableFromDivergence({ ahead: 0, behind: 3 }, true)).toBe(
      true,
    )
    expect(updateAvailableFromDivergence({ ahead: 2, behind: 3 }, true)).toBe(
      true,
    )
    expect(updateAvailableFromDivergence({ ahead: 0, behind: 0 }, false)).toBe(
      false,
    )
    // Unknown divergence must not advertise an update (avoids false positives).
    expect(updateAvailableFromDivergence(null, true)).toBe(false)
  })

  it('exports a 24h update-check TTL aligned with the Runtimes daily poll', async () => {
    const { UPDATE_CHECK_TTL_MS } = await import('./update-system')
    const { PRODUCT_UPDATE_CHECK_INTERVAL_MS } = await import(
      '@/lib/managed-agent-runtime/update-check-ttl'
    )
    expect(UPDATE_CHECK_TTL_MS).toBe(PRODUCT_UPDATE_CHECK_INTERVAL_MS)
    expect(UPDATE_CHECK_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('scheduleWorkspaceUiRestart', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects non-git install kinds without spawning', () => {
    const spawn = vi.fn()
    const exit = vi.fn()
    const result = scheduleWorkspaceUiRestart({
      installKind: 'desktop',
      spawn,
      exit,
    })
    expect(result).toEqual({
      ok: false,
      error: 'Desktop restart is handled by the app updater.',
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('spawns detached server-entry then exits for git installs', () => {
    vi.useFakeTimers()
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ unref }))
    const exit = vi.fn()
    const cwd = process.cwd()
    const result = scheduleWorkspaceUiRestart({
      installKind: 'git',
      spawn,
      exit,
      cwd,
      execPath: '/usr/bin/node',
      delayMs: 100,
    })
    expect(result).toEqual({ ok: true, restarting: true })
    expect(spawn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      [join(cwd, 'server-entry.js')],
      expect.objectContaining({
        cwd,
        detached: true,
        stdio: 'ignore',
      }),
    )
    expect(unref).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('rejects docker installs with a container restart hint', () => {
    expect(
      scheduleWorkspaceUiRestart({
        installKind: 'docker',
        spawn: vi.fn(),
        exit: vi.fn(),
      }),
    ).toEqual({
      ok: false,
      error: 'Restart the container to load the new build.',
    })
  })
})
