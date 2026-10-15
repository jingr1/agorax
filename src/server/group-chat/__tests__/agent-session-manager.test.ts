/** @vitest-environment node */
/**
 * Tests for agent-session-manager per-profile routing and crash recovery.
 *
 * NOTE: This file intentionally uses vi.hoisted + vi.mock at the top of the
 * module so that the mocked factories are in place before the test imports the
 * implementation under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCollabDbForTests } from '../room-store'
import type { GroupMember } from '../types'

const backend = new Map<string, boolean>()

const clients = new Map<string, ReturnType<typeof makeMockClient>>()

function makeMockClient(profile: string) {
  const sessions = new Map<
    string,
    { model?: string | null; has_model_config?: boolean }
  >()
  const deletedIds = new Set<string>()
  let createCounter = 0
  return {
    baseUrl: `http://127.0.0.1:8643`,
    profileName: profile,
    defaultModel: profile === 'architect' ? 'Kimi-K2.7-Code' : null,
    defaultProvider: profile === 'architect' ? 'tokenx' : null,
    createSession: vi.fn(async ({ title }: { title: string }) => {
      let id = `${profile}:${title}`
      // Real gateways assign fresh ids; simulate that by never reusing a
      // previously-deleted deterministic id so retirement tests see a new id.
      if (deletedIds.has(id)) {
        id = `${profile}:${title}:${++createCounter}`
      }
      backend.set(id, true)
      sessions.set(id, { model: null, has_model_config: false })
      return { id, model: null, has_model_config: false }
    }),
    getSession: vi.fn(async (sessionId: string) => {
      if (!backend.has(sessionId)) {
        const err = new Error('session not found')
        err.name = 'NotFoundError'
        throw err
      }
      const meta = sessions.get(sessionId) ?? {
        model: null,
        has_model_config: false,
      }
      return { id: sessionId, ...meta }
    }),
    deleteSession: vi.fn(async (sessionId: string) => {
      backend.delete(sessionId)
      sessions.delete(sessionId)
      deletedIds.add(sessionId)
    }),
    /** Test helper: mark a session as model-poisoned. */
    __poison(sessionId: string, model = 'Kimi-K2.7-Code') {
      sessions.set(sessionId, { model, has_model_config: false })
    },
    getMessages: vi.fn(async (sessionId: string) => {
      if (backend.has(sessionId)) return []
      const err = new Error('session not found')
      err.name = 'NotFoundError'
      throw err
    }),
    sendChat: vi.fn(async (sessionId: string) => ({
      messages: [
        {
          id: 1,
          role: 'assistant',
          content: `reply-${sessionId}`,
          timestamp: Date.now(),
        },
      ],
    })),
    streamChat: vi.fn(),
  }
}

const mockClient = vi.fn((profile: string) => {
  let c = clients.get(profile)
  if (!c) {
    c = makeMockClient(profile)
    clients.set(profile, c)
  }
  return c
})

vi.mock('../../hermes-api-profile', () => ({
  getHermesApiClient: vi.fn((profile: string) => mockClient(profile)),
}))

vi.mock('../../gateway-pool', () => ({
  ensureProfileGateway: vi.fn(async () => ({
    ok: true,
    message: 'already running',
    started: false,
  })),
}))

vi.mock('../../hermes-api', () => ({
  createSession: vi.fn(async ({ title }: { title: string }) => {
    backend.set(`global-${title}`, true)
    return { id: `global-${title}` }
  }),
  getMessages: vi.fn(async (sessionId: string) => {
    if (backend.has(sessionId)) return []
    const err = new Error('session not found')
    err.name = 'NotFoundError'
    throw err
  }),
  sendChat: vi.fn(async (sessionId: string) => ({
    messages: [
      {
        id: 1,
        role: 'assistant',
        content: `global-reply-${sessionId}`,
        timestamp: Date.now(),
      },
    ],
  })),
}))

function makeMember(profile: string | null): GroupMember {
  return {
    id: 'm1',
    participantId: 'dev',
    displayName: 'Dev',
    mentionName: 'dev',
    name: 'Dev',
    runtime: profile ? 'hermes' : 'codex',
    kind: 'agent',
    isBot: true,
    profile,
  }
}

describe('agent-session-manager', () => {
  let dbPath: string

  beforeEach(async () => {
    dbPath = resetCollabDbForTests()
    backend.clear()
    vi.clearAllMocks()
    const mod = await import('../agent-session-manager')
    mod.clearSessionCache()
  })

  it('creates per-profile session with deterministic title', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember('researcher')
    const { sessionId, existed, profile } = await mod.getOrCreateSession(
      'room1',
      member,
      { dbPath },
    )
    expect(existed).toBe(false)
    expect(profile).toBe('researcher')
    expect(sessionId).toBe(
      `researcher:${mod.groupSessionTitle('room1', 'dev')}`,
    )
    expect(mod.groupSessionTitle('room1', 'dev')).toBe('Group: room1:dev')
  })

  it('reuses cached session id', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember('researcher')
    const first = await mod.getOrCreateSession('room1', member, { dbPath })
    const second = await mod.getOrCreateSession('room1', member, { dbPath })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.existed).toBe(true)
  })

  it('refuses codex Hermes session create (no global fallback)', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember(null)
    member.runtime = 'codex'
    await expect(
      mod.getOrCreateSession('room1', member, { dbPath }),
    ).rejects.toThrow(/do not support runtime=codex/)
  })

  it('ignores stale profile on claude-code and refuses Hermes session create', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember(null)
    member.runtime = 'claude-code'
    member.participantId = 'cc-impl'
    member.displayName = 'cc-impl'
    member.profile = 'cc-impl' // wrongly stored agent id as Hermes profile
    await expect(
      mod.getOrCreateSession('room1', member, { dbPath }),
    ).rejects.toThrow(/do not support runtime=claude-code/)
    // Must not have contacted a per-profile Hermes client for cc-impl.
    expect(mockClient).not.toHaveBeenCalledWith('cc-impl')
  })

  it('refuses codex even when a stale profile string is present', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember(null)
    member.runtime = 'codex'
    member.profile = 'cc-impl'
    await expect(
      mod.getOrCreateSession('room1', member, { dbPath }),
    ).rejects.toThrow(/do not support runtime=codex/)
    expect(mockClient).not.toHaveBeenCalledWith('cc-impl')
  })

  it('recovers session from database after cache miss', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember('architect')
    const { sessionId } = await mod.getOrCreateSession('room1', member, {
      dbPath,
    })
    // Clear cache only; DB still holds mapping.
    mod.clearSessionCache()
    backend.set(sessionId, true)
    const recovered = await mod.getOrCreateSession('room1', member, { dbPath })
    expect(recovered.sessionId).toBe(sessionId)
    expect(recovered.existed).toBe(true)
  })

  it('recreates session when stored session is missing on gateway', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember('architect')
    const first = await mod.getOrCreateSession('room1', member, { dbPath })
    // Expunge from mock backend but keep DB mapping.
    backend.clear()
    const client = mockClient('architect')
    const createCalls = client.createSession.mock.calls.length
    const second = await mod.getOrCreateSession('room1', member, { dbPath })
    // A new session must have been created because the old one no longer exists.
    expect(second.existed).toBe(false)
    expect(client.createSession.mock.calls.length).toBeGreaterThan(createCalls)
  })

  it('retires sessions that persist a model even when has_model_config is false', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember('architect')
    const first = await mod.getOrCreateSession('room1', member, { dbPath })
    const client = mockClient('architect') as ReturnType<typeof makeMockClient>
    client.__poison(first.sessionId)
    const createCalls = client.createSession.mock.calls.length
    const second = await mod.getOrCreateSession('room1', member, { dbPath })
    expect(second.existed).toBe(false)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(client.deleteSession).toHaveBeenCalledWith(first.sessionId)
    expect(client.createSession.mock.calls.length).toBeGreaterThan(createCalls)
  })

  it('submitPrompt returns assistant message and profile', async () => {
    const mod = await import('../agent-session-manager')
    const member = makeMember('researcher')
    const res = await mod.submitPrompt('room1', member, 'hello', { dbPath })
    expect(res.profile).toBe('researcher')
    expect(res.message?.role).toBe('assistant')
    expect(res.message?.content).toContain('reply-')
  })
})
