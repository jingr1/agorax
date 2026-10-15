import { describe, expect, it, vi } from 'vitest'
import {
  registerStreamHandoffHandler,
  requestStreamHandoffIfActive,
} from './stream-handoff-bridge'

describe('stream-handoff-bridge', () => {
  it('returns false when no handler is registered', async () => {
    registerStreamHandoffHandler(null)
    await expect(requestStreamHandoffIfActive()).resolves.toBe(false)
  })

  it('delegates to the registered handler', async () => {
    const handler = vi.fn(async () => true)
    registerStreamHandoffHandler(handler)
    await expect(requestStreamHandoffIfActive()).resolves.toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    registerStreamHandoffHandler(null)
  })
})
