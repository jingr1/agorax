/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const streamChat = vi.fn()
const stopRun = vi.fn()
const getMessages = vi.fn()
const getOrCreateSession = vi.fn()
const forgetSession = vi.fn()
const ensureProfileGateway = vi.fn(async () => undefined)
const runManagedTurn = vi.fn()
const interrupt = vi.fn()
const getSessionDetail = vi.fn()
const getRunBinding = vi.fn()

vi.mock('../../agent-runtime/router', () => ({ getAgentRuntimeRouter: () => ({ getAdapter: () => ({ interrupt }) }) }))
vi.mock('../../agent-runtime/agorax-managed-run-store', () => ({ AgoraxManagedRunStore: class { get = getRunBinding } }))
vi.mock('../../agent-runtime/agorax-managed-agent-http-client', () => ({ AgoraxManagedAgentHttpClient: class { getSessionDetail = getSessionDetail } }))

vi.mock('../../hermes-api-profile', () => ({
  getHermesApiClient: () => ({
    baseUrl: 'http://127.0.0.1:8644',
    streamChat,
    stopRun,
    getMessages,
    deleteSession: vi.fn(),
  }),
}))

vi.mock('../../hermes-api', () => ({
  streamChat,
  stopRun,
  getMessages,
}))

vi.mock('../../gateway-pool', () => ({
  ensureProfileGateway,
}))

vi.mock('../agent-session-manager', () => ({
  getOrCreateSession,
  forgetSession,
}))

vi.mock('../../agent-runtime/run-managed-turn', () => ({
  runManagedTurn,
}))

const upsertManagedInteractionCard = vi.fn()

vi.mock('../managed-interaction-cards', () => ({
  upsertManagedInteractionCard,
}))

vi.mock('../../agent-runtime/managed-chat-store', () => ({
  roomManagedSessionId: (roomId: string, participantId: string) =>
    `gc:${roomId}:${participantId}`,
  ensureManagedChatSession: vi.fn(),
  resolveNativeSessionForRun: vi.fn(() => ({
    nativeSessionId: 'native-uuid',
    resume: false,
  })),
  recordNativeSessionId: vi.fn(),
}))

vi.mock('../constants', async () => {
  const actual =
    await vi.importActual<typeof import('../constants')>('../constants')
  return {
    ...actual,
    GROUP_TURN_TIMEOUT_MS: 50,
    GROUP_TURN_POLL_MS: 10,
    GROUP_TURN_HARD_CAP_MS: 200,
  }
})

describe('executeMemberTurn timeout / stranded', () => {
  beforeEach(() => {
    vi.resetModules()
    streamChat.mockReset()
    stopRun.mockReset()
    getMessages.mockReset()
    getOrCreateSession.mockReset()
    forgetSession.mockReset()
    ensureProfileGateway.mockClear()
    runManagedTurn.mockReset()
    interrupt.mockReset()
    getSessionDetail.mockReset()
    getRunBinding.mockReset()
    upsertManagedInteractionCard.mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('waits for the exact managed canonical turn after interrupt is requested', async () => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', 'http://127.0.0.1:8788')
    vi.stubEnv('AGORAX_WORKSPACE_ID', 'workspace-1')
    interrupt.mockResolvedValue(undefined)
    getRunBinding.mockResolvedValue({ agentSessionId: 'managed-session', turnId: 'target-turn' })
    let confirm!: (detail: unknown) => void
    getSessionDetail.mockResolvedValueOnce({ turns: [{ turnId: 'older-turn', phase: 'settled' }, { turnId: 'target-turn', phase: 'running' }] })
      .mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    runManagedTurn.mockImplementation((input) => {
      input.onEvent({ type: 'run_started', runId: 'managed-room-run', agentId: 'cc-impl' })
      return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({ kind: 'failed', runId: 'managed-room-run', reason: 'aborted', events: [] }), { once: true }))
    })
    const { executeMemberTurn } = await import('../turn-executor')
    const { cancelRoomTurns, hasActiveRoomTurns } = await import('../turn-control')
    const turn = executeMemberTurn({ roomId: 'managed-pause', roomTitle: 'Pause', prompt: 'work', member: {
      id: 'cc', kind: 'agent', participantId: 'cc-impl', displayName: 'Claude', name: 'Claude', mentionName: 'claude', runtime: 'claude-code', isBot: true, profile: null,
    } })
    let paused = false
    const pause = cancelRoomTurns('managed-pause').then(() => { paused = true })
    await vi.waitFor(() => expect(getSessionDetail).toHaveBeenCalledTimes(2), { interval: 1 })
    expect(interrupt).toHaveBeenCalledWith('managed-room-run', 'room paused')
    expect(getSessionDetail).toHaveBeenCalledWith('managed-session')
    expect(paused).toBe(false)
    expect(hasActiveRoomTurns('managed-pause')).toBe(true)
    confirm({ turns: [{ turnId: 'target-turn', phase: 'settled' }] })
    await pause
    await expect(turn).resolves.toEqual({ kind: 'pass' })
  })

  it('stops the exact Hermes run when Pause precedes the started event', async () => {
    getOrCreateSession.mockResolvedValue({ sessionId: 'room-session', profile: 'developer' })
    getMessages.mockResolvedValue([])
    let release!: () => void
    let started!: () => void
    const stream = new Promise<void>((resolve) => { release = resolve })
    streamChat.mockImplementation((_session, _body, options) => {
      started = () => options.onEvent({ event: 'started', data: { run_id: 'precise-room-run' } })
      return stream
    })
    stopRun.mockImplementation(() => { release(); return Promise.resolve({ status: 'canceled' }) })
    const { executeMemberTurn } = await import('../turn-executor')
    const { cancelRoomTurns } = await import('../turn-control')
    const turn = executeMemberTurn({ roomId: 'precise-room', roomTitle: 'Pause race', prompt: 'work', member: {
      id: 'row', kind: 'agent', participantId: 'developer', displayName: 'developer', name: 'developer', mentionName: 'developer', runtime: 'hermes', isBot: true, profile: 'developer',
    } })
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledOnce(), { interval: 1 })
    const pause = cancelRoomTurns('precise-room')
    expect(stopRun).not.toHaveBeenCalled()
    started()
    await pause
    expect(stopRun).toHaveBeenCalledExactlyOnceWith('precise-room-run')
    await expect(turn).resolves.toEqual({ kind: 'pass' })
  })

  it('does not submit a Hermes turn when Pause wins during the history read', async () => {
    getOrCreateSession.mockResolvedValue({ sessionId: 'not-submitted', profile: 'developer' })
    let release!: (messages: Array<unknown>) => void
    getMessages.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const { executeMemberTurn } = await import('../turn-executor')
    const { cancelRoomTurns } = await import('../turn-control')
    const turn = executeMemberTurn({ roomId: 'before-submit', roomTitle: 'Pause race', prompt: 'work', member: {
      id: 'row', kind: 'agent', participantId: 'developer', displayName: 'developer', name: 'developer', mentionName: 'developer', runtime: 'hermes', isBot: true, profile: 'developer',
    } })
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledOnce(), { interval: 1 })
    const pause = cancelRoomTurns('before-submit')
    release([])
    await pause
    await expect(turn).resolves.toEqual({ kind: 'pass' })
    expect(streamChat).not.toHaveBeenCalled()
    expect(stopRun).not.toHaveBeenCalled()
  })

  it('returns timeout without treating early ack as reply when soft deadline elapses', async () => {
    getOrCreateSession.mockResolvedValue({
      sessionId: 'sess_dev',
      existed: true,
      profile: 'developer',
    })
    getMessages.mockResolvedValue([
      { role: 'user', content: 'prior' },
      { role: 'assistant', content: 'prior reply' },
    ])

    // Stream that keeps emitting activity but never settles within soft deadline.
    let settle!: () => void
    const gate = new Promise<void>((resolve) => {
      settle = resolve
    })
    streamChat.mockImplementation(
      async (
        _sid: string,
        _body: unknown,
        opts: {
          onEvent: (p: { event: string; data: Record<string, unknown> }) => void
        },
      ) => {
        opts.onEvent({
          event: 'assistant.delta',
          data: { delta: '我先去查一下' },
        })
        await gate
      },
    )

    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'developer',
        displayName: 'developer',
        name: 'developer',
        mentionName: 'developer',
        runtime: 'hermes',
        isBot: true,
        profile: 'developer',
      },
      prompt: 'please investigate',
    })

    expect(result.kind).toBe('timeout')
    if (result.kind === 'timeout') {
      expect(result.sessionId).toBe('sess_dev')
      expect(result.before).toBe(2)
    }
    settle()
    await Promise.resolve()
  })

  it('picks newest substantive session reply on successful stream', async () => {
    getOrCreateSession.mockResolvedValue({
      sessionId: 'sess_dev',
      existed: true,
      profile: 'developer',
    })
    getMessages
      .mockResolvedValueOnce([{ role: 'user', content: 'prior' }])
      .mockResolvedValueOnce([
        { role: 'user', content: 'prior' },
        { role: 'user', content: 'prompt' },
        { role: 'assistant', content: 'early ack' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
        { role: 'tool', content: '{}' },
        { role: 'assistant', content: 'final conclusion' },
      ])

    streamChat.mockImplementation(
      async (
        _sid: string,
        _body: unknown,
        opts: {
          onEvent: (p: { event: string; data: Record<string, unknown> }) => void
        },
      ) => {
        opts.onEvent({
          event: 'assistant.delta',
          data: { delta: 'early ack' },
        })
        opts.onEvent({
          event: 'assistant.completed',
          data: { content: 'early ack' },
        })
      },
    )

    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'developer',
        displayName: 'developer',
        name: 'developer',
        mentionName: 'developer',
        runtime: 'hermes',
        isBot: true,
        profile: 'developer',
      },
      prompt: 'please investigate',
    })

    expect(result).toEqual({ kind: 'reply', text: 'final conclusion' })
  })

  it('routes claude-code members through runManagedTurn without Hermes session', async () => {
    runManagedTurn.mockResolvedValue({
      kind: 'completed',
      runId: 'run_cc',
      text: 'claude reply',
      exitCode: 0,
      events: [],
    })

    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'cc-impl',
        displayName: 'Claude Code',
        name: 'Claude Code',
        mentionName: 'claude',
        runtime: 'claude-code',
        isBot: true,
        profile: null,
      },
      prompt: 'group prompt',
    })

    expect(result).toEqual({
      kind: 'reply',
      text: 'claude reply',
      runId: 'run_cc',
    })
    expect(runManagedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'cc-impl',
        task: 'group prompt',
        roomId: 'room1',
        nativeSessionId: 'native-uuid',
        nativeResume: false,
      }),
    )
    expect(getOrCreateSession).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
  })

  it('passes cwd through to runManagedTurn for managed members', async () => {
    runManagedTurn.mockResolvedValue({
      kind: 'completed',
      runId: 'run_cc',
      text: 'ok',
      exitCode: 0,
      events: [],
    })
    const { executeMemberTurn } = await import('../turn-executor')
    await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'cc-impl',
        displayName: 'Claude Code',
        name: 'Claude Code',
        mentionName: 'claude',
        runtime: 'claude-code',
        isBot: true,
        profile: null,
      },
      prompt: 'group prompt',
      cwd: '/tmp/room-ws',
    })
    expect(runManagedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/room-ws',
      }),
    )
  })

  it('maps managed (pass) replies', async () => {
    runManagedTurn.mockResolvedValue({
      kind: 'completed',
      runId: 'run_cc',
      text: '(pass)',
      exitCode: 0,
      events: [],
    })
    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'cc-impl',
        displayName: 'Claude Code',
        name: 'Claude Code',
        mentionName: 'claude',
        runtime: 'claude-code',
        isBot: true,
        profile: null,
      },
      prompt: 'nothing for me',
    })
    expect(result).toEqual({ kind: 'pass' })
  })

  it('projects canonical interaction_update events to room cards and tracks turn liveness', async () => {
    runManagedTurn.mockImplementation(
      async (input: {
        onEvent?: (event: unknown) => void
        whileInteractionPending?: () => boolean
      }) => {
        const interaction = {
          agentSessionId: 'agent-session-1',
          turnId: 'turn-1',
          requestId: 'request-1',
          kind: 'approval' as const,
          status: 'pending' as const,
          toolName: 'shell',
          input: {},
          metadata: {},
          output: null,
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        }
        input.onEvent?.({
          type: 'activity',
          runId: 'run_cc',
          workspaceId: 'default',
          activity: {
            workspaceId: 'default',
            agentSessionId: 'agent-session-1',
            eventType: 'interaction_update',
            data: {
              workspaceId: 'default',
              agentSessionId: 'agent-session-1',
              eventType: 'interaction_update',
              occurredAtUnixMs: 1,
              interaction,
            },
          },
        })
        // Turn stays alive while the canonical interaction is pending.
        expect(input.whileInteractionPending?.()).toBe(true)

        input.onEvent?.({
          type: 'activity',
          runId: 'run_cc',
          workspaceId: 'default',
          activity: {
            workspaceId: 'default',
            agentSessionId: 'agent-session-1',
            eventType: 'interaction_update',
            data: {
              workspaceId: 'default',
              agentSessionId: 'agent-session-1',
              eventType: 'interaction_update',
              occurredAtUnixMs: 2,
              interaction: { ...interaction, status: 'answered' },
            },
          },
        })
        expect(input.whileInteractionPending?.()).toBe(false)
        return {
          kind: 'completed',
          runId: 'run_cc',
          text: 'done',
          exitCode: 0,
          events: [],
        }
      },
    )

    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'cc-impl',
        displayName: 'Claude Code',
        name: 'Claude Code',
        mentionName: 'claude',
        runtime: 'claude-code',
        isBot: true,
        profile: null,
      },
      prompt: 'group prompt',
    })

    expect(result).toEqual({ kind: 'reply', text: 'done', runId: 'run_cc' })
    expect(upsertManagedInteractionCard).toHaveBeenCalledTimes(2)
    expect(upsertManagedInteractionCard).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'room1',
        runId: 'run_cc',
        interaction: expect.objectContaining({
          requestId: 'request-1',
          status: 'pending',
        }),
      }),
    )
  })

  it('maps Hermes infra failure assistant text to failed (not room reply)', async () => {
    getOrCreateSession.mockResolvedValue({
      sessionId: 'sess_writer',
      existed: true,
      profile: 'writer',
    })
    const failure =
      "API call failed after 3 retries: cannot import name '_bound_prompt_cache_key_field'"
    getMessages.mockResolvedValue([
      { role: 'user', content: 'prior' },
      { role: 'assistant', content: failure },
    ])
    streamChat.mockImplementation(
      async (
        _sessionId: string,
        _body: unknown,
        opts?: {
          onEvent?: (payload: {
            event: string
            data: Record<string, unknown>
          }) => void
        },
      ) => {
        opts?.onEvent?.({
          event: 'assistant.completed',
          data: { content: failure },
        })
      },
    )
    const { executeMemberTurn } = await import('../turn-executor')
    const result = await executeMemberTurn({
      roomId: 'room1',
      roomTitle: 'test',
      member: {
        id: 'row',
        kind: 'agent',
        participantId: 'writer',
        displayName: 'writer',
        name: 'writer',
        mentionName: 'writer',
        runtime: 'hermes',
        isBot: true,
        profile: 'writer',
      },
      prompt: 'write the report',
    })
    expect(result).toEqual({
      kind: 'failed',
      reason: failure,
    })
  })
})
