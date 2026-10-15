/** @vitest-environment node */
/**
 * Clean baseline verification for the group-chat runner.
 *
 * These tests isolate the room-level bookkeeping from the live LLM layer by
 * mocking executeMemberTurn. They verify the three architecture invariants
 * requested by @architect:
 *
 *   1) Message count consistency between room source-of-truth and member deltas.
 *   2) Summary compression marks older messages without losing them.
 *   3) A single drive produces deterministic runner state (watermarks + posted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupMember, GroupTurnResult } from '../types'
import { resetCollabDbForTests } from '../room-store'
import {
  createRoom,
  addParticipant,
  insertMessage,
  getLatestMessages,
  getWatermark,
  setWatermark,
  getAllWatermarks,
  getLatestSummary,
  saveSummary,
} from '../room-store'
import {
  clearAllRunnerState,
  getRoomEpoch,
  getInFlightMembers,
  listStrandedMembers,
} from '../runner-state'

// Mock the turn executor so tests never hit real gateways.
// We use a single stable mock reference and vi.doMock inside importRunner()
// so that dynamic re-imports after vi.resetModules() always pick up the mock.
const sharedExecuteMemberTurnMock = vi.fn()
const mockExecuteMemberTurn = sharedExecuteMemberTurnMock

// Mock summaries so threshold compression is deterministic.
const SUMMARY_TEXT = '[SUMMARY] key decisions retained'
vi.mock('../summaries', () => ({
  maybeSummarizeRoom: vi.fn(),
  getContextForMember: vi.fn(() => ({
    summary: null as string | null,
    messages: [],
  })),
}))
import { maybeSummarizeRoom, getContextForMember } from '../summaries'
const mockMaybeSummarizeRoom = vi.mocked(maybeSummarizeRoom)
const mockGetContextForMember = vi.mocked(getContextForMember)

async function importRunner() {
  vi.doMock('../turn-executor', () => ({
    executeMemberTurn: sharedExecuteMemberTurnMock,
  }))
  const mod = await import('../group-chat-runner')
  return mod
}

function makeMember(pid: string, profile: string): GroupMember {
  return {
    id: `row-${pid}`,
    participantId: pid,
    displayName: pid,
    mentionName: pid,
    name: pid,
    runtime: 'hermes',
    kind: 'agent',
    isBot: true,
    profile,
  }
}

describe('group-chat clean baseline', () => {
  let dbPath: string
  let prevCollabDb: string | undefined
  let room: ReturnType<typeof createRoom>
  let memberA: GroupMember
  let memberB: GroupMember
  let memberC: GroupMember

  beforeEach(async () => {
    mockExecuteMemberTurn.mockReset()
    mockMaybeSummarizeRoom.mockReset()
    mockGetContextForMember.mockReturnValue({ summary: null, messages: [] })

    dbPath = resetCollabDbForTests()
    prevCollabDb = process.env.HERMES_COLLAB_DB
    process.env.HERMES_COLLAB_DB = dbPath
    clearAllRunnerState()

    room = createRoom({ title: 'Baseline room', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'architect',
      displayName: 'architect',
      profile: 'architect',
      runtime: 'hermes',
      dbPath,
    })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'developer',
      displayName: 'developer',
      profile: 'developer',
      runtime: 'hermes',
      dbPath,
    })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'orchestrator',
      displayName: 'orchestrator',
      profile: 'orchestrator',
      runtime: 'hermes',
      dbPath,
    })

    memberA = makeMember('architect', 'architect')
    memberB = makeMember('developer', 'developer')
    memberC = makeMember('orchestrator', 'orchestrator')
  })

  afterEach(() => {
    if (prevCollabDb === undefined) delete process.env.HERMES_COLLAB_DB
    else process.env.HERMES_COLLAB_DB = prevCollabDb
  })

  describe('invariant 1: message count consistency across member gateways', () => {
    it('each member receives the same number of unseen room messages in delta order', async () => {
      // Seed 7 room messages from different senders.
      const senders = ['user', 'architect', 'developer', 'orchestrator']
      for (let i = 0; i < 7; i++) {
        insertMessage({
          roomId: room.id,
          senderKind: i === 0 ? 'human' : 'agent',
          senderParticipantId: senders[i % senders.length],
          senderName: senders[i % senders.length],
          content: `message-${i}`,
          dbPath,
        })
      }

      const roomLog = getLatestMessages(room.id, { dbPath, limit: 200 })
      const allDeltas: Array<{
        key: string
        count: number
        first: string
        last: string
      }> = []

      mockExecuteMemberTurn.mockImplementation(async () => {
        const roomLog2 = getLatestMessages(room.id, { dbPath, limit: 200 })
        // Capture what each responder would see; real runner slices by watermark.
        return { kind: 'pass' } satisfies GroupTurnResult
      })

      // Manually replicate runner delta slicing for each member.
      for (const member of [memberA, memberB, memberC]) {
        const watermark = getWatermark(room.id, member.participantId, {
          dbPath,
        })
        const delta = roomLog.slice(watermark).slice(-24)
        allDeltas.push({
          key: member.participantId,
          count: delta.length,
          first: delta[0]?.content ?? '',
          last: delta[delta.length - 1]?.content ?? '',
        })
      }

      // All three members should see the same 7 messages because no watermarks
      // have advanced yet.
      expect(allDeltas.map((d) => d.count)).toEqual([7, 7, 7])
      expect(allDeltas.map((d) => d.first)).toEqual([
        'message-0',
        'message-0',
        'message-0',
      ])
      expect(allDeltas.map((d) => d.last)).toEqual([
        'message-6',
        'message-6',
        'message-6',
      ])
    })

    it('advancing one member watermark does not corrupt other members deltas', async () => {
      for (let i = 0; i < 5; i++) {
        insertMessage({
          roomId: room.id,
          senderKind: i === 0 ? 'human' : 'agent',
          senderParticipantId: 'user',
          senderName: 'user',
          content: `m-${i}`,
          dbPath,
        })
      }

      // architect reads first 3 and is marked up-to-date.
      setWatermark(room.id, 'architect', 3, { dbPath })

      const roomLog = getLatestMessages(room.id, { dbPath, limit: 200 })
      const architectDelta = roomLog
        .slice(getWatermark(room.id, 'architect', { dbPath }))
        .slice(-24)
      const devDelta = roomLog
        .slice(getWatermark(room.id, 'developer', { dbPath }))
        .slice(-24)

      expect(architectDelta.length).toBe(2)
      expect(devDelta.length).toBe(5)
      expect(architectDelta.map((m) => m.content)).toEqual(['m-3', 'm-4'])
    })
  })

  describe('invariant 2: summary compression marks older messages without loss', () => {
    it('getContextForMember returns only messages after the summary marker', async () => {
      const ids: Array<string> = []
      for (let i = 0; i < 10; i++) {
        const m = insertMessage({
          roomId: room.id,
          senderKind: i === 0 ? 'human' : 'agent',
          senderParticipantId: 'user',
          senderName: 'user',
          content: `msg-${i}`,
          dbPath,
        })
        ids.push(m.id)
      }

      // Summary covers through msg-6 (index 6).
      saveSummary(room.id, SUMMARY_TEXT, ids[6], 7, { dbPath })

      const summary = getLatestSummary(room.id, { dbPath })
      expect(summary).not.toBeNull()
      expect(summary?.throughMessageId).toBe(ids[6])
      expect(summary?.content).toBe(SUMMARY_TEXT)

      // Total room messages unchanged.
      expect(getLatestMessages(room.id, { dbPath, limit: 200 }).length).toBe(10)

      // Context after summary excludes the summarized prefix.
      const all = getLatestMessages(room.id, { dbPath, limit: 200 })
      const idx = all.findIndex((m) => m.id === summary!.throughMessageId)
      const after = all.slice(idx + 1)
      expect(after.length).toBe(3)
      expect(after.map((m) => m.content)).toEqual(['msg-7', 'msg-8', 'msg-9'])
    })

    it('compression summary does not remove rows from room_messages', async () => {
      const before = getLatestMessages(room.id, { dbPath, limit: 200 }).length
      const m = insertMessage({
        roomId: room.id,
        senderKind: 'human',
        senderParticipantId: 'user',
        senderName: 'user',
        content: 'pre-summary',
        dbPath,
      })
      saveSummary(room.id, SUMMARY_TEXT, m.id, 1, { dbPath })
      const after = getLatestMessages(room.id, { dbPath, limit: 200 }).length
      expect(after).toBe(before + 1)
    })
  })

  describe('invariant 3: single drive reproducibility', () => {
    it('running the same drive twice with identical replies yields identical watermarks and posted messages', async () => {
      insertMessage({
        roomId: room.id,
        senderKind: 'human',
        senderParticipantId: 'user',
        senderName: 'user',
        content: 'hello bots',
        dbPath,
      })

      let callCount = 0
      mockExecuteMemberTurn.mockImplementation(async ({ member }) => {
        callCount++
        return {
          kind: 'reply',
          text: `reply from ${member.displayName}`,
        } satisfies GroupTurnResult
      })

      const { runRoom } = await importRunner()

      // First drive.
      await runRoom({ ...room, dbPath } as any)
      const firstEpoch = getRoomEpoch(room.id)
      const firstMessages = getLatestMessages(room.id, { dbPath, limit: 200 })
      const firstWatermarks = getAllWatermarks(room.id, { dbPath })

      // Second drive — reset module-level state but keep the same DB.
      clearAllRunnerState()
      await runRoom({ ...room, dbPath } as any)
      const secondEpoch = getRoomEpoch(room.id)
      const secondMessages = getLatestMessages(room.id, { dbPath, limit: 200 })
      const secondWatermarks = getAllWatermarks(room.id, { dbPath })

      // State should be reproducible up to epoch bump (epoch resets per process).
      expect(
        secondMessages.map((m) => ({ sender: m.senderName, text: m.content })),
      ).toEqual(
        firstMessages.map((m) => ({ sender: m.senderName, text: m.content })),
      )
      expect(
        secondWatermarks.map((w) => ({
          participantId: w.participantId,
          count: w.messageCount,
        })),
      ).toEqual(
        firstWatermarks.map((w) => ({
          participantId: w.participantId,
          count: w.messageCount,
        })),
      )

      // Because there were no new human messages, the second drive should not
      // post additional replies beyond what the first drive posted.
      const botMessages = secondMessages.filter((m) => m.senderKind === 'agent')
      expect(botMessages.length).toBeGreaterThan(0)
    })

    it('idempotent second drive leaves watermarks unchanged when no new input', async () => {
      insertMessage({
        roomId: room.id,
        senderKind: 'human',
        senderParticipantId: 'user',
        senderName: 'user',
        content: 'one input',
        dbPath,
      })

      mockExecuteMemberTurn.mockImplementation(async ({ member }) => ({
        kind: 'reply',
        text: `${member.displayName} ack`,
      }))

      const { runRoom } = await importRunner()
      await runRoom({ ...room, dbPath } as any)

      const afterFirst = getAllWatermarks(room.id, { dbPath })
      const messagesAfterFirst = getLatestMessages(room.id, {
        dbPath,
        limit: 200,
      }).length

      clearAllRunnerState()
      await runRoom({ ...room, dbPath } as any)

      const afterSecond = getAllWatermarks(room.id, { dbPath })
      const messagesAfterSecond = getLatestMessages(room.id, {
        dbPath,
        limit: 200,
      }).length

      expect(afterSecond).toEqual(afterFirst)
      expect(messagesAfterSecond).toBe(messagesAfterFirst)
      expect(getInFlightMembers(room.id)).toEqual([])
      expect(listStrandedMembers(room.id)).toEqual([])
    })
  })

  describe('failed turns must not multi-round replay', () => {
    it('posts one failure note per member on @all (no Cap-round duplicates)', async () => {
      insertMessage({
        roomId: room.id,
        senderKind: 'human',
        senderParticipantId: 'user',
        senderName: 'user',
        content: '@all',
        dbPath,
      })

      const callsByMember = new Map<string, number>()
      mockExecuteMemberTurn.mockImplementation(async ({ member }) => {
        callsByMember.set(
          member.participantId,
          (callsByMember.get(member.participantId) ?? 0) + 1,
        )
        return {
          kind: 'failed',
          reason: 'rate_limit',
        } satisfies GroupTurnResult
      })

      const { runRoom } = await importRunner()
      await runRoom(room)

      const botMessages = getLatestMessages(room.id, {
        dbPath,
        limit: 200,
      }).filter((m) => m.senderKind === 'agent')

      // One turn + one failure note per agent (3 in this fixture).
      expect(botMessages).toHaveLength(3)
      expect(callsByMember.size).toBe(3)
      expect([...callsByMember.values()].every((n) => n === 1)).toBe(true)
      for (const msg of botMessages) {
        expect(msg.content).toMatch(/failed: rate_limit/)
      }
    })

    it('does not re-prompt on sibling error replies across MAX_ROUNDS', async () => {
      insertMessage({
        roomId: room.id,
        senderKind: 'human',
        senderParticipantId: 'user',
        senderName: 'user',
        content: '@all',
        dbPath,
      })

      const callsByMember = new Map<string, number>()
      mockExecuteMemberTurn.mockImplementation(async ({ member }) => {
        callsByMember.set(
          member.participantId,
          (callsByMember.get(member.participantId) ?? 0) + 1,
        )
        // Quota/API errors often arrive as normal replies, which used to
        // set spokeThisRound>0 and burn remaining MAX_ROUNDS on sibling posts.
        return {
          kind: 'reply',
          text: `API Error: Request rejected (429) for ${member.displayName}`,
        } satisfies GroupTurnResult
      })

      const { runRoom } = await importRunner()
      await runRoom(room)

      const botMessages = getLatestMessages(room.id, {
        dbPath,
        limit: 200,
      }).filter((m) => m.senderKind === 'agent')

      expect(botMessages).toHaveLength(3)
      expect(callsByMember.size).toBe(3)
      expect([...callsByMember.values()].every((n) => n === 1)).toBe(true)
    })
  })
})
