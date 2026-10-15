import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createManagedAgentCommandPort,
  createManagedAgentEngine,
  hydrateManagedAgentEngine,
  ingestManagedUserPromptMessage,
  managedAgentTargetId,
  managedSessionSettingsPatch,
  selectManagedAgentChatState,
  syncPendingApprovalsIntoEngine,
} from './managed-agent-engine'
import { selectEngineInteractionsForSession } from '@agorax/agent-activity-core'
import type { AgentActivityMessage } from '@agorax/agent-activity-core'

describe('Managed Agent Engine adapter', () => {
  it('upserts waiting_approval tool rows into pending Interactions for respond admit', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [
        {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          messageId: 'toolcall:bash',
          turnId: 'turn-1',
          role: 'assistant',
          kind: 'tool_call',
          status: 'waiting_approval',
          payload: {
            callType: 'approval',
            name: 'Approval',
            status: 'waiting_approval',
            input: {
              requestId: '0',
              options: [
                { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
              ],
              toolCall: { title: 'Bash', toolCallId: 'bash-1' },
            },
            output: { text: '{"command":"pwd"}' },
          },
          version: 1,
          sequence: 1,
          occurredAtUnixMs: 1,
        },
      ],
      interactions: [],
    })
    const interactions = selectEngineInteractionsForSession(
      engine.getSnapshot(),
      'session-1',
    )
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({
      requestId: '0',
      turnId: 'turn-1',
      kind: 'approval',
      status: 'pending',
    })
    // Second sync is a no-op (no duplicate upserts needed for admit).
    syncPendingApprovalsIntoEngine(engine, [
      {
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'toolcall:bash',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'tool_call',
        status: 'waiting_approval',
        payload: {
          callType: 'approval',
          input: {
            requestId: '0',
            options: [
              { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            ],
          },
        },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      },
    ] as AgentActivityMessage[])
    expect(
      selectEngineInteractionsForSession(engine.getSnapshot(), 'session-1'),
    ).toHaveLength(1)
    engine.dispose()
  })

  it('hydrates messages, turns, and interactions into one Engine owner', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'message-1', turnId: 'turn-1', role: 'assistant', kind: 'text', payload: { text: 'hello' }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [{ agentSessionId: 'session-1', requestId: 'request-1', turnId: 'turn-1', kind: 'approval', status: 'pending', createdAtUnixMs: 1, updatedAtUnixMs: 1 }],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(state.messages).toHaveLength(1)
    expect(state.activeTurn?.turnId).toBe('turn-1')
    expect(state.isStreaming).toBe(true)
    // agorax: turn busy stays true even when reply text already hosts.
    expect(state.turnBusy).toBe(true)
    expect(state.streamingMessageId).toBe('message-1')
    expect(state.interactions[0]?.requestId).toBe('request-1')
    engine.dispose()
  })

  it('ingestManagedUserPromptMessage seeds pending host homologous with Hermes', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    ingestManagedUserPromptMessage({
      engine,
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      clientSubmitId: 'c-m1',
      text: 'hello managed',
    })
    const chat = selectManagedAgentChatState(engine.getSnapshot(), 'session-1', {
      isSubmitting: true,
    })
    expect(chat.messages.map((m) => m.id)).toEqual([
      'user:c-m1',
      'assistant:pending:session-1:c-m1',
    ])
    expect(chat.isStreaming).toBe(true)
    expect(chat.turnBusy).toBe(true)
    expect(chat.streamingMessageId).toBe('assistant:pending:session-1:c-m1')
    engine.dispose()
  })

  it('folds daemon turn orphan into the pending host while open', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    ingestManagedUserPromptMessage({
      engine,
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      clientSubmitId: 'c-fold',
      text: 'ping',
      occurredAtUnixMs: 1_700_000_000_000,
    })
    engine.dispatch({
      type: 'message/snapshotReceived',
      messages: [
        {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          messageId: 'daemon-asst-1',
          turnId: 'daemon-turn-uuid',
          role: 'assistant',
          kind: 'text',
          status: 'streaming',
          payload: { text: 'pong from daemon' },
          version: 1_700_000_000_002,
          sequence: 1_700_000_000_002,
          occurredAtUnixMs: 1_700_000_000_002,
        },
      ],
    })
    const chat = selectManagedAgentChatState(engine.getSnapshot(), 'session-1', {
      isSubmitting: true,
    })
    expect(chat.messages.map((m) => m.id)).toEqual([
      'user:c-fold',
      'assistant:pending:session-1:c-fold',
    ])
    expect(chat.messages[1]).toMatchObject({
      content: [{ type: 'text', text: 'pong from daemon' }],
    })
    expect(chat.streamingMessageId).toBe('assistant:pending:session-1:c-fold')
    engine.dispose()
  })

  it('keeps processing indicator while the active turn is running even with host content', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [],
      interactions: [],
    })

    const emptyGap = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(emptyGap.isStreaming).toBe(true)
    expect(emptyGap.turnBusy).toBe(true)
    expect(emptyGap.streamingMessageId).toBeNull()

    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'reasoning-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'reasoning',
        payload: { text: '用户在询问我当前在做什么。', source: 'runtime' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      }],
      interactions: [],
    })

    const withThinking = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(withThinking.isStreaming).toBe(true)
    expect(withThinking.turnBusy).toBe(true)
    expect(withThinking.streamingMessageId).toBe('reasoning-1')
    engine.dispose()
  })

  it('projects live assistant_thinking deltas into the message lane', () => {
    const liveThinking: AgentActivityMessage[] = [{
      workspaceId: 'workspace-1',
      agentSessionId: 'session-1',
      messageId: 'thought-1',
      turnId: 'turn-1',
      role: 'assistant_thinking',
      kind: 'reasoning',
      payload: { text: 'The user greeted me in Chinese.', content: 'The user greeted me in Chinese.' },
      version: 1,
      sequence: 1,
      occurredAtUnixMs: 1,
    }]

    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [],
      interactions: [],
    })
    const projected = selectManagedAgentChatState(engine.getSnapshot(), 'session-1', {
      sessionMessages: liveThinking,
    })
    expect(projected.turnBusy).toBe(true)
    expect(projected.streamingMessageId).toBe('thought-1')
    expect(projected.messages[0]?.role).toBe('assistant')
    expect(projected.messages[0]?.content?.[0]).toMatchObject({
      type: 'thinking',
      thinking: 'The user greeted me in Chinese.',
    })
    engine.dispose()
  })

  it('derives active tool calls from canonical tool_call messages', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-1', turnId: 'turn-1', role: 'assistant', kind: 'tool_call', payload: { toolName: 'read_file', input: { path: 'README.md' } }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(state.activeToolCalls).toEqual([
      { id: 'tool-1', name: 'read_file', phase: 'running', args: { path: 'README.md' } },
    ])
    // Same-turn Activity rows fold to one host (shared with Hermes).
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 'tool-1',
      role: 'assistant',
    })
    expect(
      (state.messages[0]?.content as Array<{ type?: string; name?: string }>).some(
        (part) => part.type === 'toolCall' && part.name === 'read_file',
      ),
    ).toBe(true)
    engine.dispose()
  })

  it('still admits the legacy tool kind with name/arguments payload', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-legacy', turnId: 'turn-1', role: 'assistant', kind: 'tool', payload: { name: 'read_file', arguments: { path: 'README.md' } }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').activeToolCalls).toEqual([
      { id: 'tool-legacy', name: 'read_file', phase: 'running', args: { path: 'README.md' } },
    ])
    engine.dispose()
  })

  it('projects reasoning messages as thinking content', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{ workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'reasoning-1', turnId: 'turn-1', role: 'assistant', kind: 'reasoning', payload: { text: 'Let me check the config first.', source: 'runtime' }, version: 1, sequence: 1, occurredAtUnixMs: 1 }],
      interactions: [],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 'reasoning-1',
      role: 'assistant',
    })
    expect(state.messages[0]?.content?.[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Let me check the config first.',
    })
    engine.dispose()
  })

  it('folds reasoning + text into one assistant host (shared with Hermes)', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const settled = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'succeeded' as const,
      settledAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: {
        ...session(),
        activeTurnId: null,
        activeTurn: null,
        latestTurn: settled,
      },
      turns: [settled],
      messages: [
        {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          messageId: 'reasoning-1',
          turnId: 'turn-1',
          role: 'assistant',
          kind: 'reasoning',
          payload: { text: '用户在问有没有待审批。', source: 'runtime' },
          version: 1,
          sequence: 1,
          occurredAtUnixMs: 1,
        },
        {
          workspaceId: 'workspace-1',
          agentSessionId: 'session-1',
          messageId: 'asst-1',
          turnId: 'turn-1',
          role: 'assistant',
          kind: 'text',
          payload: { text: '目前没有。' },
          version: 2,
          sequence: 2,
          occurredAtUnixMs: 2,
        },
      ],
      interactions: [],
    })
    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 'asst-1',
      role: 'assistant',
    })
    const content = state.messages[0]?.content as Array<{ type?: string }>
    expect(content?.some((part) => part.type === 'thinking')).toBe(true)
    expect(content?.some((part) => part.type === 'text')).toBe(true)
    engine.dispose()
  })

  it('projects settled tool_call output/error onto the tool card fields', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [
        { workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-1', turnId: 'turn-1', role: 'assistant', kind: 'tool_call', status: 'completed', payload: { toolName: 'bash', input: { command: 'ls' }, output: 'README.md\nsrc' }, version: 2, sequence: 1, occurredAtUnixMs: 1 },
        { workspaceId: 'workspace-1', agentSessionId: 'session-1', messageId: 'tool-2', turnId: 'turn-1', role: 'assistant', kind: 'tool_call', status: 'failed', payload: { toolName: 'bash', input: { command: 'false' }, error: 'command exited 1' }, version: 2, sequence: 2, occurredAtUnixMs: 2 },
      ],
      interactions: [],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    // Terminal tool calls leave the active list.
    expect(state.activeToolCalls).toEqual([])
    // Same turn → one host carrying both tool cards.
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ id: 'tool-1', role: 'assistant' })
    const streamTools = (
      state.messages[0] as { __streamToolCalls?: Array<{ id: string; phase: string; result?: string }> }
    ).__streamToolCalls
    expect(streamTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tool-1',
          phase: 'complete',
          result: 'README.md\nsrc',
        }),
        expect.objectContaining({
          id: 'tool-2',
          phase: 'error',
          result: 'command exited 1',
        }),
      ]),
    )
    engine.dispose()
  })

  it('projects the canonical provider error without replacing its message', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const failedTurn = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'failed' as const,
      error: {
        code: 'insufficient_credits',
        message: 'Token-X quota exhausted',
        detail: 'HTTP 429: insufficient_quota',
      },
      settledAtUnixMs: 2,
      updatedAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: { ...session(), activeTurnId: null, activeTurn: null, latestTurn: failedTurn },
      turns: [failedTurn],
      messages: [],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').error)
      .toBe('Token-X quota exhausted')
    engine.dispose()
  })

  it('projects the daemon visible error body verbatim', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const completedTurn = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'completed' as const,
      settledAtUnixMs: 2,
      updatedAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: { ...session(), activeTurnId: null, activeTurn: null, latestTurn: completedTurn },
      turns: [completedTurn],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'error-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        status: 'failed',
        payload: {
          kind: 'agent_visible_error',
          origin: 'provider',
          text: 'Provider error',
          detail: 'Claude API: rate limit exceeded',
        },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 2,
      }],
      interactions: [],
    })

    const visible = selectManagedAgentChatState(engine.getSnapshot(), 'session-1')
    expect(visible.error).toBe('Claude API: rate limit exceeded')
    expect(visible.messages[0]?.content).toEqual([
      { type: 'text', text: 'Claude API: rate limit exceeded' },
    ])
    engine.dispose()
  })

  it('surfaces terminal provider system notice detail when no answer exists', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    const completedTurn = {
      ...turn(),
      phase: 'settled' as const,
      outcome: 'completed' as const,
      settledAtUnixMs: 2,
      updatedAtUnixMs: 2,
    }
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: { ...session(), activeTurnId: null, activeTurn: null, latestTurn: completedTurn },
      turns: [completedTurn],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'notice-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        status: 'completed',
        payload: {
          kind: 'agent_system_notice',
          text: 'MCP server startup failed',
          detail: 'MCP handshake failed: connection closed',
        },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 2,
      }],
      interactions: [],
    })

    expect(selectManagedAgentChatState(engine.getSnapshot(), 'session-1').error)
      .toBe('MCP handshake failed: connection closed')
    engine.dispose()
  })

  it('admits the Managed Chat initial activation input', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'default',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    expect(engine.activateSession({
      mode: 'new',
      agentSessionId: 'session-1',
      agentTargetId: 'managed:codex',
      clientSubmitId: 'submit-1',
      requestId: 'request-1',
      initialTurnExpected: true,
      initialContent: [{ type: 'text', text: 'Hello' }],
      initialDisplayPrompt: 'Hello',
      settings: { model: 'gpt-5' },
    })).toBe(true)
    engine.dispose()
  })

  it('uses daemon catalog identities for managed targets', () => {
    expect(managedAgentTargetId('codex-impl')).toBe('local:codex')
    expect(managedAgentTargetId('claude-code')).toBe('local:claude-code')
    expect(managedAgentTargetId('kimi-impl')).toBe('extension:kimi-code')
    expect(managedAgentTargetId('kimi')).toBe('extension:kimi-code')
    expect(managedAgentTargetId('cursor-impl')).toBe('local:cursor')
    expect(managedAgentTargetId('opencode-impl')).toBe('local:opencode')
  })

  it('prefers overlay sessionMessages over the canonical engine lane', () => {
    const engine = createManagedAgentEngine({
      workspaceId: 'workspace-1',
      commandPort: { kind: 'typed', effects: unsupportedEffects(), execute: async () => undefined },
    })
    hydrateManagedAgentEngine(engine, {
      ...detailDefaults,
      workspaceId: 'workspace-1',
      session: session(),
      turns: [turn()],
      messages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        payload: { text: 'canonical' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      }],
      interactions: [],
    })

    const state = selectManagedAgentChatState(engine.getSnapshot(), 'session-1', {
      sessionMessages: [{
        workspaceId: 'workspace-1',
        agentSessionId: 'session-1',
        messageId: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        kind: 'text',
        payload: { text: 'canonical live' },
        version: 1,
        sequence: 1,
        occurredAtUnixMs: 1,
      }],
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      id: 'message-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'canonical live' }],
      timestamp: 1,
    })
    expect(state.activeTurn?.turnId).toBe('turn-1')
    engine.dispose()
  })

  it('diffs composer model/effort against live session settings', () => {
    expect(
      managedSessionSettingsPatch({
        selectedModel: 'opencode/exo-free',
        current: { model: 'github-copilot/claude-haiku-5.5' },
      }),
    ).toEqual({ model: 'opencode/exo-free' })
    expect(
      managedSessionSettingsPatch({
        selectedModel: 'opencode/exo-free',
        current: { model: 'opencode/exo-free' },
      }),
    ).toBeNull()
    expect(
      managedSessionSettingsPatch({
        selectedModel: 'opencode/exo-free',
        effort: 'high',
        current: { model: 'opencode/exo-free', reasoningEffort: 'medium' },
      }),
    ).toEqual({ reasoningEffort: 'high' })
  })

  it('returns a scoped session from updateSessionSettings so the Engine can settle', async () => {
    const activity = {
      workspaceId: 'workspace-1',
      session: {
        ID: 'session-1',
        Provider: 'codex',
        Kind: 'root',
        ActiveTurnID: '',
        // Daemon SessionSettings JSON is camelCase (`json:"model"`).
        Settings: { model: 'opencode/exo-free' },
        MessageVersion: 1,
        Metadata: { visible: true },
        RailSectionKey: '',
      },
      turns: [],
      messages: [],
      interactions: [],
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ activity }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onActivity = vi.fn()
    const port = createManagedAgentCommandPort('opencode-impl', onActivity)
    const result = await port.effects.updateSessionSettings(
      {
        agentSessionId: 'session-1',
        commandId: 'settings:1',
        correlationId: 'session-1',
        settings: { model: 'opencode/exo-free' },
        workspaceId: 'workspace-1',
      },
      { commandId: 'settings:1', origin: 'engine' },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/opencode-impl/engine/session/session-1/settings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'opencode/exo-free' }),
      }),
    )
    expect(result).toEqual({
      agentSessionId: 'session-1',
      session: expect.objectContaining({
        agentSessionId: 'session-1',
        settings: expect.objectContaining({ model: 'opencode/exo-free' }),
      }),
    })
    expect(onActivity).toHaveBeenCalled()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const detailDefaults = {
  projection: 'authoritative' as const,
  lifecycleCapabilitiesProjected: false,
  childSessions: [] as Array<never>,
}

function session() {  return { workspaceId: 'workspace-1', agentSessionId: 'session-1', kind: 'root' as const, rootAgentSessionId: null, rootTurnId: null, parentAgentSessionId: null, parentTurnId: null, parentToolCallId: null, agentTargetId: 'local:codex', provider: 'codex', providerSessionId: null, cwd: '', title: 'Chat', activeTurnId: 'turn-1', activeTurn: turn(), latestTurn: turn(), latestTurnInteractions: [], pendingInteractions: [], settings: {}, permissionConfig: { configurable: false, modes: [] }, capabilities: null, lifecycleCapabilities: { fork: false, forkThroughTurn: false }, forkedFrom: null, usage: null, goal: null, agoraxModeActivation: null, imported: false, visible: true, resumable: true, messageVersion: 1, lastEventUnixMs: 1, startedAtUnixMs: 1, endedAtUnixMs: null, pinnedAtUnixMs: null, createdAtUnixMs: 1, updatedAtUnixMs: 1 }
}
function turn() { return { agentSessionId: 'session-1', turnId: 'turn-1', phase: 'running' as const, origin: 'user_prompt' as const, outcome: null, error: null, startedAtUnixMs: 1, settledAtUnixMs: null, updatedAtUnixMs: 1 } }
function unsupportedEffects() { const unsupported = async () => { throw new Error('unsupported') }; return { activateSession: unsupported, cancelTurn: unsupported, deleteSessions: unsupported, respondToInteraction: unsupported, renameSession: unsupported, sendInput: unsupported, setSessionPinned: unsupported, updateSessionSettings: unsupported } }