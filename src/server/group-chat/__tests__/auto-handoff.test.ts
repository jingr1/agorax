/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ensure-room-for-mission', () => ({
  ensureRoomForMission: vi.fn(async ({ missionId }: { missionId: string }) => ({
    room: {
      id: 'room-1',
      title: 'Ship',
      state: 'active',
      taskId: missionId,
      missionId,
      workspacePath: null,
      ownerParticipantId: null,
      createdAt: 1,
      updatedAt: 1,
    },
    created: true,
  })),
}))

vi.mock('../../swarm-missions', () => ({
  getSwarmMission: vi.fn(() => ({
    id: 'mission-1',
    title: 'Ship',
    state: 'done',
    createdAt: 1,
    updatedAt: 1,
    assignments: [
      {
        id: 'a1',
        workerId: 'architect',
        task: 'design',
        state: 'done',
        dependsOn: [],
      },
    ],
  })),
}))

vi.mock('../room-store', async () => {
  const actual = await vi.importActual<typeof import('../room-store')>(
    '../room-store',
  )
  return {
    ...actual,
    listParticipants: vi.fn(() => [
      {
        id: 'p1',
        roomId: 'room-1',
        kind: 'agent',
        participantId: 'developer',
        displayName: 'developer',
        mentionName: 'developer',
        description: null,
        profile: 'developer',
        runtime: 'hermes',
        isOwner: false,
        online: true,
        joinedAt: 1,
        removedAt: null,
      },
    ]),
  }
})

import { resetCollabDbForTests, listMessages } from '../room-store'
import {
  postPipelineComplete,
  postStageHandoff,
} from '../auto-handoff'
import {
  resolveGroupResponders,
  unaddressedGroupMentions,
} from '../responder-utils'
import type { GroupMember, RoomMessage } from '../types'

describe('auto-handoff', () => {
  let prevCollab: string | undefined

  beforeEach(() => {
    const dbPath = resetCollabDbForTests()
    prevCollab = process.env.HERMES_COLLAB_DB
    process.env.HERMES_COLLAB_DB = dbPath
  })

  afterEach(() => {
    if (prevCollab === undefined) delete process.env.HERMES_COLLAB_DB
    else process.env.HERMES_COLLAB_DB = prevCollab
  })

  it('posts autoHandoff system messages for each next worker', async () => {
    const messages = await postStageHandoff({
      missionId: 'mission-1',
      fromWorkerId: 'architect',
      nextAssignments: [{ id: 'a2', workerId: 'developer' }],
      handoffSummary: {
        result: 'Spec ready',
        nextAction: 'Implement',
        filesChanged: 'docs/spec.md',
      },
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]!.autoHandoff).toBe(true)
    expect(messages[0]!.content).toContain('@developer')
    expect(messages[0]!.content).toContain('Spec ready')

    const stored = listMessages(messages[0]!.roomId)
    expect(
      stored.some((m) => m.autoHandoff && m.content.includes('@developer')),
    ).toBe(true)
  })

  it('posts pipeline complete when all assignments terminal', async () => {
    const msg = await postPipelineComplete({
      missionId: 'mission-1',
      summary: 'All green',
    })
    expect(msg).not.toBeNull()
    expect(msg!.autoHandoff).toBe(true)
    expect(msg!.content).toContain('流水线完成')
  })
})

describe('responder-utils skips autoHandoff', () => {
  const members: Array<GroupMember> = [
    {
      id: '1',
      participantId: 'developer',
      displayName: 'developer',
      mentionName: 'developer',
      runtime: 'hermes',
      kind: 'agent',
      profile: 'developer',
      name: 'developer',
      isBot: true,
    },
  ]

  function msg(partial: Partial<RoomMessage>): RoomMessage {
    return {
      id: 'm1',
      roomId: 'r1',
      senderKind: 'system',
      senderParticipantId: null,
      senderName: 'System',
      content: '@developer go',
      mentions: [{ type: 'agent', participantId: 'developer' }],
      mentionDepth: 0,
      autoHandoff: true,
      taskRefs: [],
      answersPendingTurnId: null,
      runId: null,
      taskId: null,
      createdAt: Date.now(),
      ...partial,
    }
  }

  it('resolveGroupResponders ignores autoHandoff mentions', () => {
    const messages = [
      msg({
        id: 'h',
        senderKind: 'human',
        content: 'hi',
        autoHandoff: false,
        mentions: [],
      }),
      msg({ id: 'ah', autoHandoff: true, content: '@developer go' }),
    ]
    const responders = resolveGroupResponders(messages, members)
    expect(responders).toHaveLength(1)
  })

  it('unaddressedGroupMentions ignores autoHandoff citations', () => {
    const messages = [msg({ autoHandoff: true })]
    expect(unaddressedGroupMentions(messages, members)).toEqual([])
  })
})
