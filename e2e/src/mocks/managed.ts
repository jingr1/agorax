import type { Page } from '@playwright/test'

export async function installManagedMock(
  page: Page,
  initialSessionId: string,
  options: { empty?: boolean } = {},
) {
  let sessionId = initialSessionId
  const workspaceId = 'e2e-workspace'
  let title = 'E2E managed session'
  let removed = options.empty ?? false
  let settings: Record<string, unknown> = {}
  const messages: Array<Record<string, unknown>> = []
  let turn: Record<string, unknown> | null = null
  const session = () => ({
    workspaceId,
    agentSessionId: sessionId,
    kind: 'root',
    rootAgentSessionId: null,
    rootTurnId: null,
    parentAgentSessionId: null,
    parentTurnId: null,
    parentToolCallId: null,
    agentTargetId: 'cc-impl',
    provider: 'claude-code',
    providerSessionId: sessionId,
    cwd: '',
    title,
    activeTurnId: null,
    activeTurn: null,
    latestTurn: turn,
    latestTurnInteractions: [],
    pendingInteractions: [],
    settings,
    permissionConfig: { configurable: false, modes: [] },
    capabilities: null,
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    forkedFrom: null,
    usage: null,
    goal: null,
    agoraxModeActivation: null,
    imported: false,
    visible: true,
    resumable: true,
    messageVersion: messages.length,
    lastEventUnixMs: Date.now(),
    startedAtUnixMs: 1,
    endedAtUnixMs: null,
    pinnedAtUnixMs: null,
    createdAtUnixMs: 1,
    updatedAtUnixMs: Date.now(),
  })
  const detail = () => ({
    projection: 'authoritative',
    lifecycleCapabilitiesProjected: true,
    workspaceId,
    session: session(),
    childSessions: [],
    turns: turn ? [turn] : [],
    messages,
    interactions: [],
  })
  const meta = () => ({
    sessionId,
    agentId: 'cc-impl',
    title,
    createdAt: new Date(1).toISOString(),
    lastMessageAt: new Date().toISOString(),
    metadata: {},
  })
  const activity = () => ({
    workspaceId,
    session: {
      ID: sessionId,
      WorkspaceID: workspaceId,
      Provider: 'claude-code',
      Kind: 'root',
      ActiveTurnID: '',
      Settings: settings,
      Metadata: { visible: true },
      RailSectionKey: '',
      Title: title,
      MessageVersion: messages.length,
      CreatedAtUnixMS: 1,
      UpdatedAtUnixMS: Date.now(),
    },
    turns: turn
      ? [
          {
            AgentSessionID: sessionId,
            TurnID: turn.turnId,
            Phase: 'settled',
            Outcome: 'completed',
            Origin: 'user_prompt',
            StartedAtUnixMS: 1,
            SettledAtUnixMS: Date.now(),
          },
        ]
      : [],
    messages: messages.map((message, index) => ({
      ID: index + 1,
      AgentSessionID: sessionId,
      MessageID: message.messageId,
      TurnID: message.turnId,
      Version: index + 1,
      Role: message.role,
      Kind: 'text',
      Status: 'completed',
      Payload: message.payload,
      Semantics: { userVisibleAssistantResponse: message.role === 'assistant' },
      OccurredAtUnixMS: index + 1,
    })),
    interactions: [],
  })
  const recordInput = (content: string, clientSubmitId: string) => {
    const turnId = `turn-${clientSubmitId}`
    turn = {
      agentSessionId: sessionId,
      turnId,
      phase: 'settled',
      origin: 'user_prompt',
      outcome: 'completed',
      error: null,
      startedAtUnixMs: Date.now(),
      settledAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
    }
    for (const [role, text] of [
      ['user', content],
      ['assistant', `Managed reply: ${content}`],
    ])
      messages.push({
        workspaceId,
        agentSessionId: sessionId,
        messageId:
          role === 'user'
            ? `user:${clientSubmitId}`
            : `assistant:${clientSubmitId}`,
        turnId,
        role,
        kind: 'text',
        status: 'completed',
        semantics: { userVisibleAssistantResponse: role === 'assistant' },
        payload: { text },
        version: messages.length + 1,
        sequence: messages.length + 1,
        occurredAtUnixMs: Date.now(),
      })
  }
  await page.route('**/api/agents/cc-impl/**', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const method = route.request().method()
    if (pathname === '/api/agents/cc-impl/engine/activate') {
      const body = route.request().postDataJSON() as {
        agentSessionId: string
        message: string
      }
      sessionId = body.agentSessionId
      title = 'E2E created session'
      removed = false
      recordInput(body.message, 'created-submit')
      await route.fulfill({
        json: { runId: 'managed-created-run', activity: activity() },
      })
    } else if (pathname === '/api/agents/cc-impl/sessions') {
      await route.fulfill({ json: { sessions: removed ? [] : [meta()] } })
    } else if (pathname.endsWith(`/sessions/${sessionId}`)) {
      if (method === 'PATCH')
        title = String(route.request().postDataJSON().title)
      if (method === 'DELETE') removed = true
      await route.fulfill({ json: { ok: true, session: meta(), messages: [] } })
    } else if (pathname.endsWith('/detail')) {
      await route.fulfill({ json: { detail: detail() } })
    } else if (pathname.endsWith('/messages')) {
      await route.fulfill({
        json: { messages, latestVersion: messages.length, hasMore: false },
      })
    } else if (pathname.endsWith('/settings')) {
      settings = { ...settings, ...route.request().postDataJSON() }
      await route.fulfill({ json: { activity: activity() } })
    } else if (pathname.endsWith('/input')) {
      const body = route.request().postDataJSON() as {
        content: string
        clientSubmitId: string
      }
      recordInput(body.content, body.clientSubmitId)
      await route.fulfill({
        json: { result: { State: 'accepted' }, activity: activity() },
      })
    } else {
      await route.fallback()
    }
  })
}
