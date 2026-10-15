/**
 * node --test coverage for the canonical managed-agent HTTP client reads and
 * the core AgentActivityAdapter mapping. Run with:
 *
 *   ~/.nvm/versions/node/v22.22.3/bin/node \
 *     --test --experimental-strip-types --experimental-transform-types \
 *     src/server/agent-runtime/agorax-managed-agent-http-client-node-test.ts
 *
 * (--experimental-transform-types is required because the import graph
 * contains non-erasable parameter properties; the resolve hook registered
 * below bridges the app's extensionless relative imports.)
 */
import { register } from 'node:module'

register(new URL('./node-test-ts-resolve-hook.mjs', import.meta.url))

const { describe, it } = await import('node:test')
const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default
const {
  AgoraxManagedAgentHttpClient,
} = await import('./agorax-managed-agent-http-client.ts')
const {
  createAgoraxManagedAgentActivityAdapter,
} = await import('./agorax-managed-agent-activity-adapter.ts')

function mockFetch(body: unknown, status = 200): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function clientFor(input: { body: unknown; status?: number; workspaceId?: string }): {
  client: InstanceType<typeof AgoraxManagedAgentHttpClient>
  calls: Array<{ url: string; init: RequestInit }>
} {
  const { fetchImpl, calls } = mockFetch(input.body, input.status ?? 200)
  const client = new AgoraxManagedAgentHttpClient({
    baseUrl: 'http://127.0.0.1:9120/',
    workspaceId: input.workspaceId ?? 'workspace-1',
    fetchImpl,
  })
  return { client, calls }
}

const daemonSession = {
  ID: 'session-1',
  WorkspaceID: 'workspace-1',
  Kind: 'root',
  RootAgentSessionID: '',
  RootTurnID: '',
  ParentAgentSessionID: '',
  ParentTurnID: '',
  ParentToolCallID: '',
  Origin: 'user_prompt',
  UserID: 'user-1',
  AgentTargetID: 'local:claude-code',
  Provider: 'claude-code',
  ProviderSessionID: '',
  Model: '',
  Settings: null,
  Capabilities: null,
  Metadata: { visible: true, imported: false },
  InternalRuntimeContext: null,
  Cwd: '/repo',
  RailSectionKind: '',
  RailProjectPath: '',
  RailSectionKey: 'default',
  Title: 'Demo',
  ActiveTurnID: 'turn-1',
  MessageVersion: 7,
  LastEventUnixMS: 0,
  StartedAtUnixMS: 1,
  EndedAtUnixMS: 0,
  PinnedAtUnixMS: 0,
  CreatedAtUnixMS: 1,
  UpdatedAtUnixMS: 2,
}

const daemonTurn = {
  WorkspaceID: 'workspace-1',
  AgentSessionID: 'session-1',
  TurnID: 'turn-1',
  IdentityAnchorTurnID: '',
  CapabilityRefs: null,
  Phase: 'settled',
  Outcome: 'completed',
  ErrorMessage: '',
  ErrorCode: '',
  FileChanges: null,
  CompletedCommandKind: '',
  CompletedCommandStatus: '',
  FinalAssistantMessageID: '',
  FinalAssistantMessageResolved: false,
  Backfilled: false,
  StartedAtUnixMS: 2,
  SettledAtUnixMS: 8,
  CreatedAtUnixMS: 2,
  UpdatedAtUnixMS: 8,
  Origin: 'user_prompt',
  SourceGoalOperationID: '',
  SourceGoalRevision: 0,
  SourceGoalRepairEpoch: 0,
  RootProviderTurnID: '',
  ProviderTurnBindingJSON: null,
  ProviderForkBindingAvailable: false,
  RootProviderTurnPhase: '',
  RootProviderTurnOutcome: '',
  RootProviderTurnErrorMessage: '',
  RootProviderTurnErrorCode: '',
  RootProviderTurnCompletedCommandKind: '',
  RootProviderTurnCompletedCommandStatus: '',
  RootProviderTurnUpdatedAtUnixMS: 0,
}

const daemonMessage = {
  ID: 1,
  AgentSessionID: 'session-1',
  MessageID: 'message-1',
  Version: 7,
  TurnID: 'turn-1',
  Role: 'assistant',
  Kind: 'text',
  Status: 'completed',
  Semantics: null,
  Payload: { text: 'hello' },
  OccurredAtUnixMS: 5,
  StartedAtUnixMS: 3,
  CompletedAtUnixMS: 6,
  CreatedAtUnixMS: 4,
  UpdatedAtUnixMS: 6,
}

const daemonInteraction = {
  WorkspaceID: 'workspace-1',
  AgentSessionID: 'session-1',
  RequestID: 'request-1',
  TurnID: 'turn-1',
  Kind: 'approval',
  Status: 'pending',
  ToolName: 'Bash',
  Input: { command: 'ls' },
  Output: null,
  Metadata: null,
  CreatedAtUnixMS: 4,
  UpdatedAtUnixMS: 4,
}

const activityResponse = {
  workspaceId: 'workspace-1',
  session: daemonSession,
  turns: [daemonTurn],
  messages: [daemonMessage],
  interactions: [daemonInteraction],
  messageVersion: 7,
  hasMoreMessages: false,
}

describe('AgoraxManagedAgentHttpClient canonical reads', () => {
  it('maps the PascalCase session list to canonical sessions', async () => {
    const { client, calls } = clientFor({
      body: { workspaceId: 'workspace-1', sessions: [daemonSession] },
    })

    const sessions = await client.listSessions()

    assert.equal(
      calls[0]?.url,
      'http://127.0.0.1:9120/v1/workspaces/workspace-1/agent-sessions',
    )
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.agentSessionId, 'session-1')
    assert.equal(sessions[0]?.workspaceId, 'workspace-1')
    assert.equal(sessions[0]?.kind, 'root')
    assert.equal(sessions[0]?.provider, 'claude-code')
    assert.equal(sessions[0]?.messageVersion, 7)
    assert.equal(sessions[0]?.activeTurnId, 'turn-1')
    assert.equal(sessions[0]?.userId, 'user-1')
  })

  it('returns an empty canonical list when the workspace has no sessions', async () => {
    const { client, calls } = clientFor({
      body: { workspaceId: 'workspace-1', sessions: [] },
    })

    await assert.doesNotReject(client.listSessions())

    const sessions = await client.listSessions()
    assert.deepEqual(sessions, [])
    assert.equal(
      calls.at(-1)?.url,
      'http://127.0.0.1:9120/v1/workspaces/workspace-1/agent-sessions',
    )
  })

  it('pages messages by afterVersion/limit and maps the paging cursor', async () => {
    const { client, calls } = clientFor({ body: activityResponse })

    const page = await client.listSessionMessages('session-1', {
      afterVersion: 3,
      limit: 50,
    })

    assert.equal(
      calls[0]?.url,
      'http://127.0.0.1:9120/v1/workspaces/workspace-1/agent-sessions/session-1/activity?afterVersion=3&limit=50',
    )
    assert.equal(page.latestVersion, 7)
    assert.equal(page.hasMore, false)
    assert.equal(page.messages.length, 1)
    assert.equal(page.messages[0]?.messageId, 'message-1')
    assert.equal(page.messages[0]?.version, 7)
    assert.equal(page.messages[0]?.sequence, 1)
    assert.equal(page.messages[0]?.role, 'assistant')
    assert.equal(page.messages[0]?.workspaceId, 'workspace-1')
  })

  it('rejects activity responses without the paging cursor', async () => {
    const { missingVersion, missingHasMore } = {
      missingVersion: (() => {
        const { messageVersion: _mv, ...rest } = activityResponse
        return rest
      })(),
      missingHasMore: (() => {
        const { hasMoreMessages: _h, ...rest } = activityResponse
        return rest
      })(),
    }
    const first = clientFor({ body: missingVersion })
    const second = clientFor({ body: missingHasMore })

    await assert.rejects(
      first.client.listSessionMessages('session-1'),
      /paging cursor/,
    )
    await assert.rejects(
      second.client.listSessionMessages('session-1'),
      /paging cursor/,
    )
  })

  it('maps the activity aggregate into a canonical detail snapshot', async () => {
    const { client, calls } = clientFor({ body: activityResponse })

    const detail = await client.getSessionDetail('session-1')

    assert.equal(
      calls[0]?.url,
      'http://127.0.0.1:9120/v1/workspaces/workspace-1/agent-sessions/session-1/activity',
    )
    assert.equal(detail.projection, 'authoritative')
    assert.equal(detail.lifecycleCapabilitiesProjected, false)
    assert.equal(detail.workspaceId, 'workspace-1')
    assert.equal(detail.session.agentSessionId, 'session-1')
    assert.equal(detail.session.messageVersion, 7)
    assert.equal(detail.session.activeTurn?.turnId, 'turn-1')
    assert.equal(detail.session.latestTurn?.turnId, 'turn-1')
    assert.equal(detail.session.pendingInteractions.length, 1)
    assert.equal(detail.turns.length, 1)
    assert.equal(detail.turns[0]?.phase, 'settled')
    assert.equal(detail.turns[0]?.outcome, 'completed')
    assert.equal(detail.messages.length, 1)
    assert.equal(detail.interactions.length, 1)
  })
})

describe('createAgoraxManagedAgentActivityAdapter', () => {
  it('serves canonical sessions and messages for its bound workspace', async () => {
    const bodies = [
      { workspaceId: 'workspace-1', sessions: [daemonSession] },
      activityResponse,
    ]
    const { fetchImpl } = mockFetch(bodies[0])
    let index = 0
    const trackingFetch = (async (url: unknown, init?: RequestInit) => {
      index += 1
      return new Response(JSON.stringify(bodies[index - 1] ?? {}), { status: 200 })
    }) as typeof fetch
    void fetchImpl
    const adapter = createAgoraxManagedAgentActivityAdapter({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl: trackingFetch,
    })

    const list = await adapter.listSessions({ workspaceId: 'workspace-1' })
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0]?.agentSessionId, 'session-1')

    const page = await adapter.listSessionMessages({
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      afterVersion: 7,
    })
    assert.equal(page.latestVersion, 7)
    assert.equal(page.messages.length, 1)
  })

  it('rejects workspaces it is not bound to', async () => {
    const adapter = createAgoraxManagedAgentActivityAdapter({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl: mockFetch({ sessions: [] }).fetchImpl,
    })

    await assert.rejects(
      adapter.listSessions({ workspaceId: 'workspace-2' }),
      /bound to workspace/,
    )
  })

  it('rejects paging shapes the daemon cannot serve', async () => {
    const adapter = createAgoraxManagedAgentActivityAdapter({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl: mockFetch(activityResponse).fetchImpl,
    })

    await assert.rejects(
      adapter.listSessionMessages({
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        beforeVersion: 3,
      }),
      /beforeVersion/,
    )
    await assert.rejects(
      adapter.listSessionMessages({
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        order: 'desc',
      }),
      /ascending only/,
    )
  })

  it('throws explicit errors for still-unsupported operations', () => {
    const adapter = createAgoraxManagedAgentActivityAdapter({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl: mockFetch({}).fetchImpl,
    })

    assert.throws(() => adapter.goalControl({} as never), /does not support goal control/)
    assert.throws(() => adapter.updateAgoraxModeActivation({} as never), /does not support Agorax mode activation/)
    assert.throws(() => adapter.forkSession({} as never), /does not support session fork/)
  })

  it('maps daemon write responses into canonical sessions and turns', async () => {
    const bodies = [
      {
        Canonical: daemonSession,
        TurnID: 'turn-1',
        Session: {},
        Kind: 'turn',
        GoalControl: null,
        SessionStatus: '',
        InitialGoalStatus: '',
      },
      {
        Canonical: daemonSession,
        Turn: daemonTurn,
        TurnID: 'turn-1',
        TurnLifecycle: { ActiveTurnID: 'turn-1', Phase: 'running', Settling: false, Outcome: null, CompletedCommand: null },
        SubmitAvailability: { State: 'ready', Reason: '' },
        Kind: 'turn',
        GoalControl: null,
        Session: {},
      },
      {
        Canonical: daemonSession,
        Operation: { OperationID: 'op-1', WorkspaceID: 'workspace-1', AgentSessionID: 'session-1', Kind: 'interaction_response', Status: 'completed', Result: '', TurnID: 'turn-1', RequestID: 'request-1', Payload: null },
        Disposition: 'answered',
      },
    ]
    let index = 0
    const calls: Array<{ url: string; init: RequestInit }> = []
    const trackingFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      index += 1
      return new Response(JSON.stringify(bodies[index - 1] ?? {}), { status: 200 })
    }) as typeof fetch
    const adapter = createAgoraxManagedAgentActivityAdapter({
      baseUrl: 'http://127.0.0.1:9120',
      workspaceId: 'workspace-1',
      fetchImpl: trackingFetch,
    })

    const created = await adapter.createSession({
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      clientSubmitId: 'submit-1',
      agentTargetId: 'local:claude-code',
      initialContent: [{ type: 'text', text: 'hello' }],
    })
    assert.equal(created.agentSessionId, 'session-1')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      agentSessionId: created.agentSessionId,
      agentTargetId: 'local:claude-code',
      clientSubmitId: 'submit-1',
      initialContent: [{ type: 'text', text: 'hello' }],
    })

    const sent = await adapter.sendInput({
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      clientSubmitId: 'submit-2',
      content: [{ type: 'text', text: 'continue' }],
    })
    assert.equal(sent.kind, 'turn')
    assert.equal(sent.turnId, 'turn-1')
    assert.equal(sent.turn.phase, 'settled')
    assert.equal(sent.session.agentSessionId, 'session-1')

    const answered = await adapter.submitInteractive({
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      optionId: 'allow',
    })
    assert.equal(answered.session.agentSessionId, 'session-1')
  })
})
