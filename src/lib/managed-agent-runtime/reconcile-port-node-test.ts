/**
 * node --test coverage for the managed-agent reconcile port: afterVersion
 * pagination loop, cursor-stall guard, and detail projection labeling.
 * Run with:
 *
 *   ~/.nvm/versions/node/v22.22.3/bin/node \
 *     --test --experimental-strip-types \
 *     src/lib/managed-agent-runtime/reconcile-port-node-test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createManagedAgentSessionReconcilePort } from './reconcile-port.ts'

const SES = 'session-1'

function message(version: number) {
  return {
    workspaceId: 'workspace-1',
    agentSessionId: SES,
    messageId: `message-${version}`,
    turnId: 'turn-1',
    role: 'assistant',
    kind: 'text',
    payload: { text: `msg ${version}` },
    version,
    sequence: version,
    occurredAtUnixMs: version,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function fetchFromPages(pages: Array<{ messages: unknown[]; latestVersion: number; hasMore: boolean }>) {
  const calls: Array<{ url: string }> = []
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    calls.push({ url })
    const page = pages[calls.length - 1]
    if (!page) return jsonResponse({ error: 'no more pages' }, 500)
    return jsonResponse({ messages: page.messages, latestVersion: page.latestVersion, hasMore: page.hasMore })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function makePort(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createManagedAgentSessionReconcilePort({
    agentId: 'codex-impl',
    fetchImpl,
    resolveDisplaySessionId: (agentSessionId) => agentSessionId,
    ...overrides,
  })
}

describe('createManagedAgentSessionReconcilePort listSessionMessages', () => {
  it('paginates afterVersion to exhaustion and returns ascending messages', async () => {
    const { fetchImpl, calls } = fetchFromPages([
      { messages: [message(1), message(2)], latestVersion: 2, hasMore: true },
      { messages: [message(3)], latestVersion: 3, hasMore: false },
    ])
    const port = makePort(fetchImpl)
    const page = await port.listSessionMessages({
      agentSessionId: SES,
      workspaceId: 'workspace-1',
      afterVersion: 0,
      limit: 100,
      order: 'asc',
    })
    assert.equal(calls.length, 2)
    assert.match(calls[0]!.url, /afterVersion=0/)
    assert.match(calls[1]!.url, /afterVersion=2/)
    assert.deepEqual(page.messages.map((entry) => entry.version), [1, 2, 3])
    assert.equal(page.latestVersion, 3)
    assert.equal(page.hasMore, false)
  })

  it('honors a beforeVersion ceiling in ascending mode', async () => {
    const { fetchImpl } = fetchFromPages([
      { messages: [message(1), message(2), message(3)], latestVersion: 3, hasMore: false },
    ])
    const port = makePort(fetchImpl)
    const page = await port.listSessionMessages({
      agentSessionId: SES,
      workspaceId: 'workspace-1',
      afterVersion: 0,
      beforeVersion: 3,
      limit: 100,
      order: 'asc',
    })
    assert.deepEqual(page.messages.map((entry) => entry.version), [1, 2])
  })

  it('serves the whole filtered tail in one page for desc beforeVersion walks', async () => {
    const { fetchImpl, calls } = fetchFromPages([
      { messages: [message(1), message(2), message(3)], latestVersion: 3, hasMore: false },
    ])
    const port = makePort(fetchImpl)
    const page = await port.listSessionMessages({
      agentSessionId: SES,
      workspaceId: 'workspace-1',
      afterVersion: 0,
      beforeVersion: 3,
      limit: 100,
      order: 'desc',
    })
    assert.equal(calls.length, 1, 'executor backwards walk terminates after one round')
    assert.deepEqual(page.messages.map((entry) => entry.version), [2, 1])
    assert.equal(page.hasMore, false)
  })

  it('bounds desc results to the requested limit when no ceiling is given', async () => {
    const { fetchImpl } = fetchFromPages([
      { messages: [message(1), message(2), message(3)], latestVersion: 3, hasMore: false },
    ])
    const port = makePort(fetchImpl)
    const page = await port.listSessionMessages({
      agentSessionId: SES,
      workspaceId: 'workspace-1',
      afterVersion: 0,
      limit: 2,
      order: 'desc',
    })
    assert.deepEqual(page.messages.map((entry) => entry.version), [3, 2])
    assert.equal(page.hasMore, true)
  })

  it('throws when the server keeps paging without advancing the cursor', async () => {
    const { fetchImpl } = fetchFromPages([
      { messages: [message(1)], latestVersion: 1, hasMore: true },
      { messages: [message(1)], latestVersion: 1, hasMore: true },
    ])
    const port = makePort(fetchImpl)
    await assert.rejects(
      port.listSessionMessages({
        agentSessionId: SES,
        workspaceId: 'workspace-1',
        afterVersion: 0,
        limit: 100,
        order: 'asc',
      }),
      /pagination did not advance/,
    )
  })

  it('throws when maxPages is exceeded', async () => {
    const { fetchImpl } = fetchFromPages([
      { messages: [message(1)], latestVersion: 1, hasMore: true },
      { messages: [message(2)], latestVersion: 2, hasMore: true },
    ])
    const port = makePort(fetchImpl, { maxPages: 1 })
    await assert.rejects(
      port.listSessionMessages({
        agentSessionId: SES,
        workspaceId: 'workspace-1',
        afterVersion: 0,
        limit: 100,
        order: 'asc',
      }),
      /exceeded 1 pages/,
    )
  })

  it('throws on an invalid page payload', async () => {
    const fetchImpl = (async () => jsonResponse({ messages: [{ nope: true }], latestVersion: 1, hasMore: false })) as typeof fetch
    const port = makePort(fetchImpl)
    await assert.rejects(
      port.listSessionMessages({
        agentSessionId: SES,
        workspaceId: 'workspace-1',
        afterVersion: 0,
        limit: 100,
        order: 'asc',
      }),
      /invalid page/,
    )
  })
})

describe('createManagedAgentSessionReconcilePort getSessionDetail', () => {
  it('labels the snapshot with the requested projection', async () => {
    const fetchImpl = (async () => jsonResponse({
      detail: {
        session: { agentSessionId: SES, workspaceId: 'workspace-1' },
        childSessions: [],
        turns: [],
      },
    })) as typeof fetch
    const port = makePort(fetchImpl)
    const detail = await port.getSessionDetail({
      agentSessionId: SES,
      workspaceId: 'workspace-1',
      projection: 'authoritative',
    })
    assert.equal(detail.projection, 'authoritative')
    assert.equal(detail.lifecycleCapabilitiesProjected, true)
  })

  it('rejects an invalid detail payload', async () => {
    const fetchImpl = (async () => jsonResponse({ detail: { session: null } })) as typeof fetch
    const port = makePort(fetchImpl)
    await assert.rejects(
      port.getSessionDetail({
        agentSessionId: SES,
        workspaceId: 'workspace-1',
        projection: 'authoritative',
      }),
      /invalid snapshot/,
    )
  })
})
