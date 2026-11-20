import { describe, expect, it, vi } from 'vitest'
import { createAgoraxManagedAgentTransport } from './agorax-managed-agent-transport'
import { AgoraxManagedRunStore } from './agorax-managed-run-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('createAgoraxManagedAgentTransport', () => {
  it.each(['terminal', 'disconnect', 'error'] as const)('cleans the owning subscription on %s and rejects a competing consumer', async (ending) => {
    const root = mkdtempSync(join(tmpdir(), 'transport-terminal-'))
    let emit: (raw: unknown) => void = () => undefined
    let disconnect: () => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const close = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ session: { id: 'session-1', activeTurnId: 'turn-1' } }), { status: 201 }))
    const transport = createAgoraxManagedAgentTransport({
      baseUrl: 'http://managed-agent.test', workspaceId: 'workspace-1', fetchImpl,
      runStore: new AgoraxManagedRunStore(root),
      socketFactory: () => ({ onMessage: (listener) => { emit = listener }, onError: (listener) => { fail = listener }, onClose: (listener) => { disconnect = listener }, close }),
    })
    const frame = (eventType: string, data: unknown) => ({ kind: 'event', event: { topic: 'agent.activity.updated', payload: { workspaceId: 'workspace-1', agentSessionId: 'session-1', eventType, data } } })
    try {
      await transport.startRun({ backend: 'codex', run: { runId: 'run-1', agentId: 'codex', task: 'hello' }, mcp: { endpoint: '', runToken: '', toolAllowlist: [] } })
      emit(frame('turn_update', { turn: { turnId: 'old-turn', phase: 'settled', outcome: 'succeeded' } }))
      expect(close).not.toHaveBeenCalled()
      emit(frame('message_delta', { agentSessionId: 'session-1', messageId: 'message-1', turnId: 'turn-1', role: 'assistant', kind: 'text', content: { operation: 'append_text', text: 'hi' } }))
      const iterator = transport.streamEvents({ backend: 'codex', runId: 'run-1' })[Symbol.asyncIterator]()
      await iterator.next()
      const competing = transport.streamEvents({ backend: 'codex', runId: 'run-1' })[Symbol.asyncIterator]()
      await expect(competing.next()).rejects.toThrow('already has an event subscriber')
      expect(close).not.toHaveBeenCalled()
      if (ending === 'terminal') emit(frame('turn_update', { turn: { turnId: 'turn-1', phase: 'settled', outcome: 'succeeded' } }))
      else if (ending === 'disconnect') disconnect()
      else fail(new Error('socket failed'))
      let next = await iterator.next()
      while (!next.done) next = await iterator.next()
      expect(transport.subscriptionStats()).toEqual({ queues: 0, bufferedEvents: 0 })
      if (ending !== 'disconnect') expect(close).toHaveBeenCalledOnce()
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('releases sockets on repeated early subscription exits without cancelling runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'transport-cleanup-'))
    let open = 0
    let emit: (raw: unknown) => void = () => undefined
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ session: { id: 'session-1', activeTurnId: 'turn-1' } }), { status: 201 }))
    const transport = createAgoraxManagedAgentTransport({
      baseUrl: 'http://managed-agent.test', workspaceId: 'workspace-1', fetchImpl,
      runStore: new AgoraxManagedRunStore(root),
      socketFactory: () => { open++; return { onMessage: (listener) => { emit = listener }, onError: () => undefined, close: () => { open-- } } },
    })
    try {
      for (let index = 0; index < 30; index++) {
        const runId = `run-${index}`
        await transport.startRun({ backend: 'codex', run: { runId, agentId: 'codex', task: 'hello' }, mcp: { endpoint: '', runToken: '', toolAllowlist: [] } })
        const iterator = transport.streamEvents({ backend: 'codex', runId })[Symbol.asyncIterator]()
        emit({ kind: 'event', event: { topic: 'agent.activity.updated', payload: { workspaceId: 'workspace-1', agentSessionId: 'session-1', eventType: 'message_delta', data: { agentSessionId: 'session-1', messageId: 'message-1', turnId: 'turn-1', role: 'assistant', kind: 'text', content: { operation: 'append_text', text: 'hi' } } } } })
        await iterator.next()
        await iterator.return?.()
        expect(open).toBe(0)
        expect(transport.subscriptionStats()).toEqual({ queues: 0, bufferedEvents: 0 })
      }
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/cancel'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('creates a canonical session and projects activity events', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'session-1', activeTurnId: 'turn-1' } }), { status: 201 }))
    const listeners: Array<(raw: unknown) => void> = []
    const root = `/tmp/agorax-transport-${Date.now()}`
    const transport = createAgoraxManagedAgentTransport({
      baseUrl: 'http://managed-agent.test',
      workspaceId: 'workspace-1',
      fetchImpl,
      runStore: new AgoraxManagedRunStore(root),
      socketFactory: () => ({
        onMessage: (listener) => listeners.push(listener),
        onError: () => undefined,
        close: () => undefined,
      }),
    })

    await transport.startRun({
      backend: 'codex',
      run: { runId: 'run-1', agentId: 'codex', task: 'hello' },
      mcp: {
        endpoint: 'http://127.0.0.1:3001/api/mcp-rpc',
        runToken: 'mcp_rw_test',
        toolAllowlist: ['task_start', 'task_complete'],
      },
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://managed-agent.test/v1/workspaces/workspace-1/agent-sessions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"mcpEndpoint":"http://127.0.0.1:3001/api/mcp-rpc"'),
      }),
    )
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain('"mcpRunToken":"mcp_rw_test"')
    const events = transport.streamEvents({ backend: 'codex', runId: 'run-1' })
    const iterator = events[Symbol.asyncIterator]()
    listeners[0]!({
      kind: 'event',
      event: {
        topic: 'agent.activity.updated',
        payload: {
          workspaceId: 'workspace-1', agentSessionId: 'session-1', eventType: 'message_delta',
          data: { agentSessionId: 'session-1', messageId: 'message-1', turnId: 'turn-1', role: 'assistant', kind: 'text', content: { operation: 'append_text', text: 'hi' } },
        },
      },
    })
    await expect(iterator.next()).resolves.toEqual({
      value: expect.objectContaining({
        type: 'activity',
        runId: 'run-1',
        workspaceId: 'workspace-1',
      }),
      done: false,
    })
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'text_delta', runId: 'run-1', text: 'hi' },
      done: false,
    })
  })

  it('reuses the canonical session for a later display-session turn', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'session-1', activeTurnId: 'turn-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'turn', turnId: 'turn-2' }), { status: 200 }))
    const root = `/tmp/agorax-transport-${Date.now()}-resume`
    const transport = createAgoraxManagedAgentTransport({
      baseUrl: 'http://managed-agent.test',
      workspaceId: 'workspace-1',
      fetchImpl,
      runStore: new AgoraxManagedRunStore(root),
      socketFactory: () => ({ onMessage: () => undefined, onError: () => undefined, close: () => undefined }),
    })

    await transport.startRun({
      backend: 'codex',
      run: { runId: 'run-1', agentId: 'codex', task: 'first', taskId: 'display-1' },
      mcp: { endpoint: 'unused', runToken: 'unused', toolAllowlist: [] },
    })
    await transport.startRun({
      backend: 'codex',
      run: { runId: 'run-2', agentId: 'codex', task: 'second', taskId: 'display-1' },
      mcp: { endpoint: 'unused', runToken: 'unused', toolAllowlist: [] },
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://managed-agent.test/v1/workspaces/workspace-1/agent-sessions/session-1/input',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})