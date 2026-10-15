/** @vitest-environment node */
/**
 * NOTE: vi.hoisted + vi.mock must stay at top so factories exist before
 * summaries.ts is imported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRoom,
  getLatestMessages,
  getLatestSummary,
  insertMessage,
  resetCollabDbForTests,
  saveSummary,
} from '../room-store'
import { GROUP_SUMMARY_THRESHOLD } from '../constants'

const { createSession, sendChat, getMessages, ensureProfileGateway } =
  vi.hoisted(() => ({
    createSession: vi.fn(),
    sendChat: vi.fn(),
    getMessages: vi.fn(),
    ensureProfileGateway: vi.fn(async () => undefined),
  }))

vi.mock('../../hermes-api-profile', () => ({
  getHermesApiClient: () => ({
    createSession,
    sendChat,
    getMessages,
    deleteSession: vi.fn(),
  }),
}))

vi.mock('../../hermes-api', () => ({
  createSession,
  sendChat,
  getMessages,
}))

vi.mock('../../gateway-pool', () => ({
  ensureProfileGateway,
}))

import {
  SUMMARY_PROMPT,
  buildSummaryRosterLegend,
  extractSummaryText,
  formatSummaryTranscriptLine,
  getContextForMember,
  isUsableSummaryText,
  maybeSummarizeRoom,
} from '../summaries'
import { addParticipant } from '../room-store'

describe('summary text helpers', () => {
  it('SUMMARY_PROMPT separates agent_id from model/provider names', () => {
    expect(SUMMARY_PROMPT).toContain('agent id')
    expect(SUMMARY_PROMPT).toContain('Kimi-K2.7-Code')
    expect(SUMMARY_PROMPT).toContain('Token-X')
    expect(SUMMARY_PROMPT).toContain('kimi-impl')
  })

  it('formatSummaryTranscriptLine tags agent_id', () => {
    expect(
      formatSummaryTranscriptLine({
        id: 'm1',
        roomId: 'r',
        senderKind: 'agent',
        senderParticipantId: 'orchestrator',
        senderName: 'orchestrator',
        content: 'Billing exhausted for Kimi-K2.7-Code via Token-X',
        mentions: [],
        mentionDepth: 0,
        autoHandoff: false,
        taskRefs: [],
        answersPendingTurnId: null,
        runId: null,
        taskId: null,
        createdAt: 1,
      }),
    ).toBe(
      'orchestrator [agent_id=orchestrator]: Billing exhausted for Kimi-K2.7-Code via Token-X',
    )
  })

  it('buildSummaryRosterLegend lists agent_id and runtime', () => {
    const dbPath = resetCollabDbForTests()
    const room = createRoom({ title: 'Roster', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'kimi-impl',
      displayName: 'kimi',
      mentionName: 'kimi',
      runtime: 'kimi',
      dbPath,
    })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'orchestrator',
      displayName: 'orchestrator',
      mentionName: 'orchestrator',
      runtime: 'hermes',
      profile: 'orchestrator',
      dbPath,
    })
    const legend = buildSummaryRosterLegend(room.id, { dbPath })
    expect(legend).toContain('agent_id=kimi-impl')
    expect(legend).toContain('runtime=kimi')
    expect(legend).toContain('agent_id=orchestrator')
    expect(legend).toMatch(/model names are not members/i)
  })

  it('rejects empty and placeholder summaries', () => {
    expect(isUsableSummaryText('')).toBe(false)
    expect(isUsableSummaryText('   ')).toBe(false)
    expect(isUsableSummaryText('(no summary)')).toBe(false)
    expect(isUsableSummaryText('no summary')).toBe(false)
    expect(isUsableSummaryText('Decided to ship X')).toBe(true)
  })

  it('extracts assistant content from messages array', () => {
    expect(
      extractSummaryText({
        messages: [
          { role: 'user', content: 'sum' },
          { role: 'assistant', content: 'Room decided on A' },
        ],
      }),
    ).toBe('Room decided on A')
  })

  it('extracts from content block arrays', () => {
    expect(
      extractSummaryText({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Key point: ship it' }],
          },
        ],
      }),
    ).toBe('Key point: ship it')
  })

  it('returns empty instead of placeholder when nothing usable', () => {
    expect(extractSummaryText({})).toBe('')
    expect(extractSummaryText({ response: '(no summary)' })).toBe('')
  })
})

describe('maybeSummarizeRoom persistence', () => {
  let dbPath: string
  let roomId: string

  beforeEach(() => {
    dbPath = resetCollabDbForTests()
    createSession.mockReset()
    sendChat.mockReset()
    getMessages.mockReset()
    ensureProfileGateway.mockClear()
    createSession.mockResolvedValue({ id: 'sum_sess' })
    getMessages.mockResolvedValue([])
    const room = createRoom({ title: 'Summary Test', dbPath })
    roomId = room.id
    for (let i = 0; i < GROUP_SUMMARY_THRESHOLD; i++) {
      insertMessage({
        roomId,
        senderKind: i % 2 === 0 ? 'human' : 'agent',
        senderParticipantId: i % 2 === 0 ? 'user' : 'dev',
        senderName: i % 2 === 0 ? 'user' : 'developer',
        content: `msg-${i}: discussing feature ${i}`,
        dbPath,
      })
    }
  })

  it('persists a real summary and advances the anchor', async () => {
    sendChat.mockResolvedValue({
      messages: [
        { role: 'user', content: '...' },
        { role: 'assistant', content: 'Team agreed to ship feature X next.' },
      ],
    })

    const saved = await maybeSummarizeRoom(roomId, {
      dbPath,
      profile: 'orchestrator',
    })
    expect(saved?.content).toBe('Team agreed to ship feature X next.')
    expect(getLatestSummary(roomId, { dbPath })?.content).toBe(
      'Team agreed to ship feature X next.',
    )
    expect(createSession).toHaveBeenCalled()
    expect(sendChat).toHaveBeenCalled()
    const prompt = String(sendChat.mock.calls[0]?.[1]?.message ?? '')
    expect(prompt).toContain('agent_id=')
    expect(prompt).toContain('Kimi-K2.7-Code')
  })

  it('does not persist placeholder / empty LLM replies', async () => {
    sendChat.mockResolvedValue({})
    getMessages.mockResolvedValue([])

    const saved = await maybeSummarizeRoom(roomId, { dbPath })
    expect(saved).toBeNull()
    expect(getLatestSummary(roomId, { dbPath })).toBeNull()
  })

  it('falls back to session getMessages when /chat body is empty', async () => {
    sendChat.mockResolvedValue({})
    getMessages.mockResolvedValue([
      { role: 'user', content: 'prompt' },
      {
        role: 'assistant',
        content: 'Recovered summary from transcript',
      },
    ])

    const saved = await maybeSummarizeRoom(roomId, { dbPath })
    expect(saved?.content).toBe('Recovered summary from transcript')
  })

  it('ignores a prior (no summary) row when choosing the window', async () => {
    const msgs = getLatestMessages(roomId, { dbPath, limit: 200 })
    saveSummary(roomId, '(no summary)', msgs[2]!.id, 3, { dbPath })

    sendChat.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Full room recap after heal' }],
    })

    const saved = await maybeSummarizeRoom(roomId, { dbPath })
    expect(saved?.content).toBe('Full room recap after heal')
    expect(saved?.throughMessageId).toBe(msgs[msgs.length - 1]!.id)
  })

  it('getContextForMember hides unusable summary and returns full history', () => {
    const msgs = getLatestMessages(roomId, { dbPath, limit: 200 })
    saveSummary(roomId, '(no summary)', msgs[2]!.id, 3, { dbPath })

    const ctx = getContextForMember(roomId, { dbPath })
    expect(ctx.summary).toBeNull()
    expect(ctx.messages.length).toBe(msgs.length)
  })

  it('returns null instead of throwing when the gateway chat fails', async () => {
    sendChat.mockRejectedValue(new Error('fetch failed'))
    const saved = await maybeSummarizeRoom(roomId, { dbPath })
    expect(saved).toBeNull()
    expect(getLatestSummary(roomId, { dbPath })).toBeNull()
  })
})
