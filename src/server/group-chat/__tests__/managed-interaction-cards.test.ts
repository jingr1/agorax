/** @vitest-environment node */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentActivityInteraction } from '@agorax/agent-activity-core'

const respondToInteraction = vi.fn()
const listInteractions = vi.fn()

vi.mock('../../agent-runtime/agorax-managed-agent-http-client', () => ({
  AgoraxManagedAgentHttpClient: vi.fn(function () {
    return { respondToInteraction, listInteractions }
  }),
}))

vi.mock('../../agent-runtime/router', () => ({
  getAgentRuntimeRouter: () => ({
    registry: { byId: new Map([['cc-impl', { runtime: 'claude-code' }]]) },
  }),
}))

// agents-config loads the gateway/profile machinery at import time, which is
// out of scope for these tests (and crashes the vitest worker in this env).
vi.mock('../../agent-runtime/agents-config', () => ({
  loadAgentsRegistry: () => ({ agents: [] }),
}))

import {
  createRoom,
  getLatestMessages,
  resetCollabDbForTests,
} from '../room-store'
import {
  decodeManagedInteractionCard,
  encodeManagedInteractionCard,
  MANAGED_INTERACTION_CARD_MARKER,
} from '@/lib/group-chat-interaction-card'
import {
  findManagedInteractionCardMessage,
  respondToManagedInteractionCard,
  upsertManagedInteractionCard,
} from '../managed-interaction-cards'

function approval(overrides: Partial<AgentActivityInteraction> = {}): AgentActivityInteraction {
  return {
    agentSessionId: 'agent-session-1',
    turnId: 'turn-1',
    requestId: 'request-1',
    kind: 'approval',
    status: 'pending',
    toolName: 'shell',
    input: {
      toolCall: { title: 'Run command?', input: { command: 'npm test' } },
    },
    metadata: { actions: [{ id: 'allow', label: 'Allow', semantic: 'approve' }] },
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    ...overrides,
  }
}

const member = {
  id: 'row',
  kind: 'agent',
  participantId: 'cc-impl',
  displayName: 'Claude Code',
  name: 'Claude Code',
  mentionName: 'claude',
  runtime: 'claude-code',
  isBot: true,
  profile: null,
} as const

describe('managed interaction card codec', () => {
  it('round-trips the canonical interaction through the content block', () => {
    const content = encodeManagedInteractionCard({
      agentSessionId: 's',
      turnId: 't',
      requestId: 'r',
      kind: 'question',
      status: 'pending',
      toolName: 'AskUserQuestion',
      input: { questions: [{ header: 'H', question: 'Q?' }] },
      metadata: { callType: 'interactive' },
      output: null,
    })
    expect(content.startsWith('[Question] AskUserQuestion')).toBe(true)
    expect(content).toContain(MANAGED_INTERACTION_CARD_MARKER)
    const decoded = decodeManagedInteractionCard(content)
    expect(decoded).toEqual({
      agentSessionId: 's',
      turnId: 't',
      requestId: 'r',
      kind: 'question',
      status: 'pending',
      toolName: 'AskUserQuestion',
      input: { questions: [{ header: 'H', question: 'Q?' }] },
      metadata: { callType: 'interactive' },
      output: null,
    })
  })

  it('fails closed on malformed or foreign content', () => {
    expect(decodeManagedInteractionCard('plain text')).toBeNull()
    expect(
      decodeManagedInteractionCard(
        `x\n\n<!--${MANAGED_INTERACTION_CARD_MARKER}\n{"agentSessionId":"s"}\n-->`,
      ),
    ).toBeNull()
    expect(
      decodeManagedInteractionCard(
        `x\n\n<!--${MANAGED_INTERACTION_CARD_MARKER}\nnot json\n-->`,
      ),
    ).toBeNull()
  })
})

describe('upsertManagedInteractionCard', () => {
  let dbPath: string
  let roomId: string

  beforeEach(() => {
    vi.clearAllMocks()
    dbPath = resetCollabDbForTests()
    roomId = createRoom({ title: 'Room', dbPath }).id
  })

  it('inserts a room card for a pending canonical interaction', () => {
    const message = upsertManagedInteractionCard({
      roomId,
      member,
      runId: 'run-1',
      interaction: approval(),
      dbPath,
    })!
    expect(message.senderParticipantId).toBe('cc-impl')
    expect(message.runId).toBe('run-1')
    const payload = decodeManagedInteractionCard(message.content)
    expect(payload?.status).toBe('pending')
    expect(payload?.requestId).toBe('request-1')
    expect(getLatestMessages(roomId, { dbPath })).toHaveLength(1)
  })

  it('updates the same card in place when the canonical status settles', () => {
    const first = upsertManagedInteractionCard({
      roomId,
      member,
      interaction: approval(),
      dbPath,
    })!
    const second = upsertManagedInteractionCard({
      roomId,
      member,
      interaction: approval({ status: 'answered', output: { answers: ['Allow'] } }),
      dbPath,
    })!
    expect(second.id).toBe(first.id)
    expect(decodeManagedInteractionCard(second.content)?.status).toBe('answered')
    expect(getLatestMessages(roomId, { dbPath })).toHaveLength(1)
  })

  it('finds cards by canonical identity', () => {
    upsertManagedInteractionCard({
      roomId,
      member,
      interaction: approval(),
      dbPath,
    })
    const found = findManagedInteractionCardMessage(
      roomId,
      { agentSessionId: 'agent-session-1', turnId: 'turn-1', requestId: 'request-1' },
      { dbPath },
    )
    expect(found).not.toBeNull()
    expect(
      findManagedInteractionCardMessage(
        roomId,
        { agentSessionId: 'agent-session-1', turnId: 'turn-1', requestId: 'other' },
        { dbPath },
      ),
    ).toBeNull()
  })
})

describe('respondToManagedInteractionCard', () => {
  let dbPath: string
  let roomId: string
  let cardMessageId: string

  beforeEach(() => {
    vi.clearAllMocks()
    dbPath = resetCollabDbForTests()
    roomId = createRoom({ title: 'Room', dbPath }).id
    cardMessageId = upsertManagedInteractionCard({
      roomId,
      member,
      interaction: approval(),
      dbPath,
    })!.id
    process.env.AGORAX_MANAGED_AGENT_URL = 'http://127.0.0.1:9'
    process.env.AGORAX_WORKSPACE_ID = 'default'
  })

  it('writes back through the daemon client and refreshes the card from the canonical list', async () => {
    respondToInteraction.mockResolvedValue({ ok: true })
    listInteractions.mockResolvedValue({
      workspaceId: 'default',
      agentSessionId: 'agent-session-1',
      interactions: [
        {
          WorkspaceID: 'default',
          AgentSessionID: 'agent-session-1',
          RequestID: 'request-1',
          TurnID: 'turn-1',
          Kind: 'approval',
          Status: 'answered',
          ToolName: 'shell',
          Input: { toolCall: { title: 'Run command?' } },
          Metadata: {},
          Output: { answers: ['Allow'] },
          CreatedAtUnixMS: 1,
          UpdatedAtUnixMS: 2,
        },
      ],
    })

    const result = await respondToManagedInteractionCard({
      roomId,
      messageId: cardMessageId,
      optionId: 'allow',
      dbPath,
    })

    expect(result).toEqual({ ok: true, status: 'answered' })
    expect(respondToInteraction).toHaveBeenCalledWith({
      agentSessionId: 'agent-session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      optionId: 'allow',
    })
    const refreshed = findManagedInteractionCardMessage(
      roomId,
      { agentSessionId: 'agent-session-1', turnId: 'turn-1', requestId: 'request-1' },
      { dbPath },
    )
    expect(decodeManagedInteractionCard(refreshed!.content)?.status).toBe('answered')
  })

  it('rejects writeback on settled cards (409-style, no daemon call)', async () => {
    upsertManagedInteractionCard({
      roomId,
      member,
      interaction: approval({ status: 'superseded' }),
      dbPath,
    })
    const result = await respondToManagedInteractionCard({
      roomId,
      messageId: cardMessageId,
      optionId: 'allow',
      dbPath,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    expect(respondToInteraction).not.toHaveBeenCalled()
  })

  it('rejects writeback on plan cards (fail closed)', async () => {
    const planCard = upsertManagedInteractionCard({
      roomId,
      member,
      interaction: approval({
        kind: 'plan',
        toolName: 'ExitPlanMode',
        input: { plan: 'do it' },
      }),
      dbPath,
    })!
    const result = await respondToManagedInteractionCard({
      roomId,
      messageId: planCard.id,
      optionId: 'implement',
      dbPath,
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(respondToInteraction).not.toHaveBeenCalled()
  })

  it('surfaces daemon writeback failures without touching the card', async () => {
    respondToInteraction.mockRejectedValue(new Error('daemon 409 conflict'))
    const result = await respondToManagedInteractionCard({
      roomId,
      messageId: cardMessageId,
      optionId: 'allow',
      dbPath,
    })
    expect(result).toEqual({ ok: false, status: 502, error: 'daemon 409 conflict' })
    const card = findManagedInteractionCardMessage(
      roomId,
      { agentSessionId: 'agent-session-1', turnId: 'turn-1', requestId: 'request-1' },
      { dbPath },
    )
    expect(decodeManagedInteractionCard(card!.content)?.status).toBe('pending')
  })
})
