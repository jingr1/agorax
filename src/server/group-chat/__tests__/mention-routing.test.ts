import { beforeEach, describe, expect, it } from 'vitest'
import {
  addParticipant,
  createRoom,
  resetCollabDbForTests,
} from '../room-store'
import {
  expandMentionTargets,
  groupMemberKey,
  parseMentions,
  resolveHumanMentions,
} from '../mention-routing'
import type { GroupMember } from '../types'

function makeAgent(id: string, overrides?: Partial<GroupMember>): GroupMember {
  return {
    id: overrides?.id ?? `${id}-id`,
    kind: 'agent',
    participantId: id,
    displayName: overrides?.displayName ?? id,
    name: overrides?.displayName ?? id,
    mentionName: overrides?.mentionName ?? '',
    runtime: (overrides?.runtime ?? 'hermes') as GroupMember['runtime'],
    isBot: true,
    profile: overrides?.profile ?? null,
  }
}

function makeHuman(id: string, overrides?: Partial<GroupMember>): GroupMember {
  return {
    id: overrides?.id ?? `${id}-id`,
    kind: 'human',
    participantId: id,
    displayName: overrides?.displayName ?? id,
    name: overrides?.displayName ?? id,
    mentionName: overrides?.mentionName ?? '',
    runtime: (overrides?.runtime ?? 'human') as GroupMember['runtime'],
    isBot: false,
    profile: overrides?.profile ?? null,
  }
}

describe('mention-routing', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = resetCollabDbForTests()
  })

  describe('parseMentions', () => {
    it('resolves @agent by participant id', () => {
      const members = [makeAgent('architect'), makeHuman('alice')]
      const parsed = parseMentions(
        'Hey @architect, what do you think?',
        members,
      )
      expect(parsed.mentioned).toContain(groupMemberKey(members[0]))
      expect(parsed.mentioned).not.toContain(groupMemberKey(members[1]))
    })

    it('resolves @displayName by first word and full name', () => {
      const members = [makeAgent('p1', { displayName: 'Code Reviewer' })]
      expect(parseMentions('@Code', members).mentioned).toContain(
        groupMemberKey(members[0]),
      )
      expect(parseMentions('@CodeReviewer', members).mentioned).toContain(
        groupMemberKey(members[0]),
      )
    })

    it('resolves @mentionName', () => {
      const members = [makeAgent('p1', { mentionName: 'helper_bot' })]
      expect(parseMentions('@helper_bot', members).mentioned).toContain(
        groupMemberKey(members[0]),
      )
    })

    it('marks @all as everyone', () => {
      expect(parseMentions('@all', [makeAgent('a')]).everyone).toBe(true)
    })

    it('does not treat @everyone as a group mention', () => {
      const members = [makeAgent('a'), makeAgent('everyone')]
      const parsed = parseMentions('@everyone hi', members)
      expect(parsed.everyone).toBe(false)
      expect(parsed.mentioned).toContain(groupMemberKey(members[1]))
    })

    it('ignores @human / @user / @me / @owner in parse phase', () => {
      const members = [makeAgent('a'), makeHuman('u')]
      expect(
        parseMentions('@human @user @me @owner', members).mentioned,
      ).toEqual([])
      expect(parseMentions('@human @user @me @owner', members).everyone).toBe(
        false,
      )
    })
  })

  describe('expandMentionTargets', () => {
    it('expands @all to every active member', () => {
      const targets = expandMentionTargets(
        { everyone: true, mentioned: [] },
        'room1',
        [makeAgent('a'), makeHuman('h')],
      )
      expect(targets).toEqual([
        { type: 'agent', participantId: 'a' },
        { type: 'human', participantId: 'h' },
      ])
    })

    it('expands @agent and @human targets', () => {
      const room = createRoom({ title: 'test', dbPath })
      addParticipant({
        roomId: room.id,
        kind: 'agent',
        participantId: 'dev',
        dbPath,
      })
      addParticipant({
        roomId: room.id,
        kind: 'human',
        participantId: 'alice',
        dbPath,
      })
      const members = [makeAgent('dev'), makeHuman('alice')]
      const targets = expandMentionTargets(
        { everyone: false, mentioned: members.map(groupMemberKey) },
        room.id,
        members,
      )
      expect(targets).toEqual([
        { type: 'agent', participantId: 'dev' },
        { type: 'human', participantId: 'alice' },
      ])
    })
  })

  describe('resolveHumanMentions', () => {
    it('returns human participants from db', () => {
      const room = createRoom({ title: 'test', dbPath })
      addParticipant({
        roomId: room.id,
        kind: 'agent',
        participantId: 'dev',
        dbPath,
      })
      addParticipant({
        roomId: room.id,
        kind: 'human',
        participantId: 'alice',
        dbPath,
      })
      expect(resolveHumanMentions(room.id, { dbPath })).toEqual([
        { type: 'human', participantId: 'alice' },
      ])
    })
  })
})
