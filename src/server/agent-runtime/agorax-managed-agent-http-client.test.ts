import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  agoraxAgentTargetIdForBackend,
  AgoraxManagedAgentHttpClient,
} from './agorax-managed-agent-http-client'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'

describe('AgoraxManagedAgentHttpClient', () => {
  it('maps the selected backends to canonical target ids', () => {
    expect(agoraxAgentTargetIdForBackend('claude-code')).toBe('local:claude-code')
    expect(agoraxAgentTargetIdForBackend('codex')).toBe('local:codex')
    expect(agoraxAgentTargetIdForBackend('cursor')).toBe('local:cursor')
    expect(agoraxAgentTargetIdForBackend('opencode')).toBe('local:opencode')
    expect(agoraxAgentTargetIdForBackend('kimi')).toBe('extension:kimi-code')
  })

  it('probes enabled targets and fail-closes missing targets', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          agents: [
            { id: 'local:cursor', enabled: true },
            { id: 'extension:kimi-code', enabled: false },
          ],
        }),
        { status: 200 },
      ),
    )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120/',
      workspaceId: 'workspace-1',
      fetchImpl,
    })

    await expect(client.probe('cursor')).resolves.toEqual({
      available: true,
      detail: 'Agorax managed target local:cursor is ready',
    })
    await expect(client.probe('kimi')).resolves.toEqual({
      available: false,
      detail: 'Agorax managed target extension:kimi-code is disabled',
    })
    // Both backends share one catalog fetch within the TTL window.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9120/v1/agent-targets',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('uses canonical workspace session endpoints for create and input', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ session: { id: 'session-1' } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { id: 'session-1' } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: 'turn', turnId: 'turn-1' }), {
          status: 200,
        }),
      )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace/1',
      fetchImpl,
    })

    await client.createSession({
      backend: 'cursor',
      agentSessionId: 'session-1',
      clientSubmitId: 'submit-1',
      content: 'hello',
    })
    await client.sendInput('session-1', {
      clientSubmitId: 'submit-2',
      content: 'continue',
      promptContent: [
        { type: 'text', text: 'continue' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          attachmentId: 'image-1',
          name: 'diagram.png',
        },
      ],
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions/session-1/input',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({
        clientSubmitId: 'submit-2',
        content: [
          { type: 'text', text: 'continue' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            attachmentId: 'image-1',
            name: 'diagram.png',
          },
        ],
      }),
    })
  })

  it('responds to an interaction using its complete canonical identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace/1',
      fetchImpl,
    })

    await client.respondToInteraction({
      agentSessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      optionId: 'allow',
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions/session-1/turns/turn-1/interactions/request-1/response',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ optionId: 'allow' }),
      }),
    )
  })

  it('reads interactions from the canonical session endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ interactions: [] }), { status: 200 }),
    )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace/1',
      fetchImpl,
    })

    await client.listInteractions('session-1')

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions/session-1/interactions',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('reads an authoritative activity snapshot for one canonical session', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ session: {}, turns: [], messages: [], interactions: [] }), { status: 200 }),
    )
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace/1',
      fetchImpl,
    })

    await client.getActivitySnapshot('session-1')

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9120/v1/workspaces/workspace%2F1/agent-sessions/session-1/activity',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('binds a display run to the canonical session returned by the daemon', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          session: { id: 'canonical-session', activeTurnId: 'turn-1' },
        }),
        { status: 201 },
      ),
    )
    const root = await mkdtemp(path.join(tmpdir(), 'agorax-managed-http-'))
    const store = new AgoraxManagedRunStore(root)
    const client = new AgoraxManagedAgentHttpClient({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl,
    })

    await client.createSessionForRun({
      runId: 'display-run-1',
      runStore: store,
      session: {
        backend: 'codex',
        agentSessionId: 'requested-session',
        clientSubmitId: 'submit-1',
        content: 'hello',
      },
    })

    try {
      await expect(store.get('display-run-1')).resolves.toMatchObject({
        agentSessionId: 'canonical-session',
        turnId: 'turn-1',
        backend: 'codex',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes the embedded daemon Go response shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ Canonical: { ID: 'session-1', ActiveTurnID: 'turn-1' }, TurnID: 'turn-1' }), { status: 201 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ Canonical: { ID: 'session-1', ActiveTurnID: 'turn-2' }, TurnID: 'turn-2', Turn: { TurnID: 'turn-2' } }), { status: 200 }),
    )
    const client = new AgoraxManagedAgentHttpClient({ baseUrl: 'http://127.0.0.1:9120', workspaceId: 'workspace-1', fetchImpl })

    await expect(client.createSession({ backend: 'codex', agentSessionId: 'session-1', clientSubmitId: 'submit-1', content: 'hello' })).resolves.toEqual({ session: { id: 'session-1', activeTurnId: 'turn-1' } })
    await expect(client.sendInput('session-1', { clientSubmitId: 'submit-2', content: 'next' })).resolves.toMatchObject({ turnId: 'turn-2', session: { id: 'session-1' } })
  })
})