import { afterEach, expect, it, vi } from 'vitest'
import { createHermesChatSession } from './create-hermes-chat-session'

const runtime = vi.hoisted(() => ({
  engine: {
    activateSession: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({
      pendingIntents: { activationsByRequestId: {} },
    })),
  },
  getMapping: vi.fn(),
  putMapping: vi.fn(),
  ensureSessionHydrated: vi.fn(),
}))
const peek = vi.hoisted(() => vi.fn())

vi.mock('@/stores/hermes-chat-runtime', () => ({
  getHermesChatRuntime: () => runtime,
  forgetHermesMappingCache: vi.fn(),
  peekHermesMappingCache: (...args: unknown[]) => peek(...args),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  peek.mockReset()
  runtime.engine.getSnapshot.mockReturnValue({
    pendingIntents: { activationsByRequestId: {} },
  })
})

it('hydrates only the confirmed gateway session after activation', async () => {
  peek.mockReturnValue({
    gatewaySessionId: 'gateway-session',
    updatedAtUnixMs: Date.now() + 1000,
  })
  await expect(
    createHermesChatSession({
      profile: 'developer',
      preferredFriendlyId: 'draft',
    }),
  ).resolves.toMatchObject({ sessionKey: 'gateway-session' })
  expect(runtime.engine.activateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      agentSessionId: 'draft',
      optimisticTitle: 'draft',
      mode: 'new',
    }),
  )
  expect(runtime.putMapping).toHaveBeenCalledWith(
    expect.objectContaining({
      agentSessionId: 'gateway-session',
      gatewaySessionId: 'gateway-session',
    }),
  )
  expect(runtime.ensureSessionHydrated).toHaveBeenCalledWith('gateway-session')
  expect(runtime.getMapping).not.toHaveBeenCalled()
})

it('rejects stale mappings rather than inventing a successful session', async () => {
  vi.useFakeTimers()
  peek.mockReturnValue({ gatewaySessionId: 'stale', updatedAtUnixMs: 1 })
  const request = createHermesChatSession({ profile: 'developer' })
  const assertion = expect(request).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await assertion
  expect(runtime.ensureSessionHydrated).not.toHaveBeenCalled()
})

it('surfaces activation failure instead of a generic timeout', async () => {
  vi.useFakeTimers()
  peek.mockReturnValue(null)
  runtime.engine.activateSession.mockImplementation(
    (input: { requestId: string }) => {
      runtime.engine.getSnapshot.mockReturnValue({
        pendingIntents: {
          activationsByRequestId: {
            [input.requestId]: {
              status: 'failed',
              errorMessage:
                'Hermes sessions API unavailable; session was not persisted on the gateway',
            },
          },
        },
      })
      return true
    },
  )
  const request = createHermesChatSession({ profile: 'developer' })
  const assertion = expect(request).rejects.toThrow('sessions API unavailable')
  await vi.advanceTimersByTimeAsync(50)
  await assertion
  expect(runtime.ensureSessionHydrated).not.toHaveBeenCalled()
})
