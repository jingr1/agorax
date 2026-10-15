import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getHermesChatRuntime,
  notifyHermesSendCompleted,
  resetHermesChatRuntimesForTests,
  waitForHermesSendCompleted,
} from './hermes-chat-runtime'

describe('hermes-chat-runtime hooks merge', () => {
  afterEach(() => {
    resetHermesChatRuntimesForTests()
    vi.unstubAllGlobals()
  })

  it('does not wipe onSseFrame when a later caller passes only profileName', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ mapping: null }), { status: 200 })),
    )
    const frames: Array<string> = []
    const runtime = getHermesChatRuntime('hook-test-ws', {
      profileName: 'default',
      onSseFrame: ({ event }) => {
        frames.push(String(event))
      },
    })
    // Simulate useHermesEngineChatState re-entry (no stream hooks).
    getHermesChatRuntime('hook-test-ws', { profileName: 'default' })

    const hooks = (
      runtime as unknown as {
        _hooks?: { onSseFrame?: (input: { event: string }) => void }
      }
    )._hooks
    hooks?.onSseFrame?.({ event: 'chunk' })
    expect(frames).toEqual(['chunk'])
  })

  it('waitForHermesSendCompleted resolves on notify success', async () => {
    const done = waitForHermesSendCompleted('c-1', { timeoutMs: 2_000 })
    notifyHermesSendCompleted('c-1')
    await expect(done).resolves.toBeUndefined()
  })

  it('waitForHermesSendCompleted rejects on notify error', async () => {
    const done = waitForHermesSendCompleted('c-2', { timeoutMs: 2_000 })
    notifyHermesSendCompleted('c-2', new Error('boom'))
    await expect(done).rejects.toThrow('boom')
  })
})
