import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivitySession } from '@agorax/agent-activity-core'

vi.mock('./agent-runtime/router', () => ({
  getAgentRuntimeRouter: () => ({
    registry: {
      byId: new Map([
        ['cc-impl', { id: 'cc-impl', runtime: 'claude-code' }],
        ['orchestrator', { id: 'orchestrator', runtime: 'hermes', profile: 'orchestrator' }],
      ]),
      orphanProfiles: [] as string[],
    },
  }),
}))

const listManagedChatSessions = vi.fn()
const renameManagedChatSession = vi.fn()
const deleteManagedChatSession = vi.fn()

vi.mock('./agent-runtime/managed-chat-store', () => ({
  listManagedChatSessions: (...args: unknown[]) => listManagedChatSessions(...args),
  renameManagedChatSession: (...args: unknown[]) => renameManagedChatSession(...args),
  deleteManagedChatSession: (...args: unknown[]) => deleteManagedChatSession(...args),
  createSessionForManagedAgent: vi.fn(),
}))

vi.mock('./profiles-browser', () => ({
  listSessionsForProfile: vi.fn(() => []),
}))

const listSessions = vi.fn()
const updateTitle = vi.fn()
const deleteSession = vi.fn()

vi.mock('./agent-runtime/agorax-managed-agent-http-client', () => {
  class AgoraxManagedAgentHttpError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = 'AgoraxManagedAgentHttpError'
      this.status = status
    }
  }
  return {
    AgoraxManagedAgentHttpClient: class {
      listSessions = (
        options?: { agentTargetId?: string; signal?: AbortSignal },
      ) => {
        const all = listSessions(options) as Promise<
          Array<{ agentSessionId: string; agentTargetId?: string | null }>
        >
        return Promise.resolve(all).then((sessions) => {
          const target = options?.agentTargetId?.trim()
          if (!target) return sessions
          return sessions.filter((session) => session.agentTargetId === target)
        })
      }
      updateTitle = updateTitle
      deleteSession = deleteSession
    },
    AgoraxManagedAgentHttpError,
  }
})

vi.mock('./agent-runtime/agorax-managed-agent-session-identity', () => ({
  resolveAgoraxManagedSessionIdentity: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    ok: true as const,
    backend: 'claude-code' as const,
    agentSessionId: sessionId,
  })),
}))

import {
  agentSessionFromDaemonActivity,
  deleteSessionForAgent,
  listSessionsForAgent,
  renameSessionForAgent,
} from './agent-sessions-service'
import { AgoraxManagedAgentHttpError } from './agent-runtime/agorax-managed-agent-http-client'

function daemonSession(
  overrides: Partial<AgentActivitySession> & { agentSessionId: string },
): AgentActivitySession {
  return {
    workspaceId: 'ws',
    kind: 'root',
    rootAgentSessionId: null,
    rootTurnId: null,
    parentAgentSessionId: null,
    parentTurnId: null,
    parentToolCallId: null,
    agentTargetId: 'local:claude-code',
    provider: 'claude-code',
    providerSessionId: null,
    cwd: '/tmp',
    title: 'Chat',
    activeTurnId: null,
    activeTurn: null,
    latestTurn: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    settings: {} as AgentActivitySession['settings'],
    permissionConfig: { configurable: false } as AgentActivitySession['permissionConfig'],
    capabilities: null,
    lifecycleCapabilities: {} as AgentActivitySession['lifecycleCapabilities'],
    forkedFrom: null,
    usage: null,
    goal: null,
    agoraxModeActivation: null,
    imported: false,
    visible: true,
    resumable: false,
    messageVersion: 0,
    lastEventUnixMs: 1_700_000_000_000,
    startedAtUnixMs: 1_700_000_000_000,
    endedAtUnixMs: null,
    pinnedAtUnixMs: null,
    createdAtUnixMs: 1_700_000_000_000,
    updatedAtUnixMs: 1_700_000_000_000,
    ...overrides,
  }
}

describe('agentSessionFromDaemonActivity', () => {
  it('maps daemon session id and title into sidebar shape', () => {
    expect(
      agentSessionFromDaemonActivity(
        'cc-impl',
        daemonSession({
          agentSessionId: 'sess-1',
          title: ' Hello ',
          updatedAtUnixMs: 1_700_000_111_000,
        }),
      ),
    ).toEqual({
      sessionId: 'sess-1',
      agentId: 'cc-impl',
      title: 'Hello',
      state: 'idle',
      lastMessageAt: new Date(1_700_000_111_000).toISOString(),
    })
  })
})

describe('listSessionsForAgent (managed daemon)', () => {
  const prevUrl = process.env.AGORAX_MANAGED_AGENT_URL
  const prevWs = process.env.AGORAX_WORKSPACE_ID

  beforeEach(() => {
    process.env.AGORAX_MANAGED_AGENT_URL = 'http://127.0.0.1:8788'
    process.env.AGORAX_WORKSPACE_ID = 'ws'
    listSessions.mockReset()
    listManagedChatSessions.mockReset()
  })

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.AGORAX_MANAGED_AGENT_URL
    else process.env.AGORAX_MANAGED_AGENT_URL = prevUrl
    if (prevWs === undefined) delete process.env.AGORAX_WORKSPACE_ID
    else process.env.AGORAX_WORKSPACE_ID = prevWs
  })

  it('returns only daemon sessions for the agent target', async () => {
    listSessions.mockResolvedValue([
      daemonSession({ agentSessionId: 'a', title: 'A', agentTargetId: 'local:claude-code' }),
      daemonSession({ agentSessionId: 'b', title: 'B', agentTargetId: 'local:codex' }),
    ])
    const sessions = await listSessionsForAgent('cc-impl')
    expect(sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(listManagedChatSessions).not.toHaveBeenCalled()
  })

  it('falls back to collab when daemon is not configured', async () => {
    delete process.env.AGORAX_MANAGED_AGENT_URL
    listManagedChatSessions.mockReturnValue([
      {
        sessionId: 'legacy',
        agentId: 'cc-impl',
        title: 'Legacy',
        state: 'idle',
        lastMessageAt: new Date().toISOString(),
      },
    ])
    const sessions = await listSessionsForAgent('cc-impl')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.sessionId).toBe('legacy')
  })
})

describe('renameSessionForAgent / deleteSessionForAgent (daemon)', () => {
  const prevUrl = process.env.AGORAX_MANAGED_AGENT_URL
  const prevWs = process.env.AGORAX_WORKSPACE_ID

  beforeEach(() => {
    process.env.AGORAX_MANAGED_AGENT_URL = 'http://127.0.0.1:8788'
    process.env.AGORAX_WORKSPACE_ID = 'ws'
    updateTitle.mockReset()
    deleteSession.mockReset()
    deleteManagedChatSession.mockReset()
    renameManagedChatSession.mockReset()
  })

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.AGORAX_MANAGED_AGENT_URL
    else process.env.AGORAX_MANAGED_AGENT_URL = prevUrl
    if (prevWs === undefined) delete process.env.AGORAX_WORKSPACE_ID
    else process.env.AGORAX_WORKSPACE_ID = prevWs
  })

  it('renames via daemon and does not require collab', async () => {
    updateTitle.mockResolvedValue({ Canonical: { Title: 'Renamed' } })
    const session = await renameSessionForAgent('cc-impl', 'sess-1', 'Renamed')
    expect(updateTitle).toHaveBeenCalledWith('sess-1', 'Renamed')
    expect(session?.title).toBe('Renamed')
    expect(renameManagedChatSession).not.toHaveBeenCalled()
  })

  it('deletes via daemon then cleans collab residue', async () => {
    deleteSession.mockResolvedValue({ Deleted: true })
    deleteManagedChatSession.mockReturnValue(true)
    await expect(deleteSessionForAgent('cc-impl', 'sess-1')).resolves.toBe(true)
    expect(deleteSession).toHaveBeenCalledWith('sess-1')
    expect(deleteManagedChatSession).toHaveBeenCalledWith({
      agentId: 'cc-impl',
      sessionId: 'sess-1',
    })
  })

  it('treats daemon 404 delete as success and still cleans collab', async () => {
    deleteSession.mockRejectedValue(
      new AgoraxManagedAgentHttpError('gone', 404),
    )
    deleteManagedChatSession.mockReturnValue(true)
    await expect(deleteSessionForAgent('cc-impl', 'sess-1')).resolves.toBe(true)
    expect(deleteManagedChatSession).toHaveBeenCalled()
  })
})
