/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ensure-room-for-mission', () => ({
  ensureRoomForMission: vi.fn(async ({ missionId }: { missionId: string }) => ({
    room: {
      id: 'room-attn',
      title: 'Need human',
      state: 'active',
      taskId: missionId,
      missionId,
      workspacePath: null,
      ownerParticipantId: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    },
    created: false,
  })),
}))

vi.mock('../room-store', async () => {
  const actual = await vi.importActual<typeof import('../room-store')>(
    '../room-store',
  )
  return {
    ...actual,
    listParticipants: vi.fn((roomId: string) => {
      const real = actual.listParticipants(roomId)
      if (real.length > 0) return real
      return [
        {
          id: 'hp',
          roomId,
          kind: 'human',
          participantId: 'user-1',
          displayName: 'User',
          mentionName: 'me',
          description: null,
          profile: null,
          runtime: 'human',
          isOwner: true,
          online: true,
          joinedAt: 1,
          removedAt: null,
        },
      ]
    }),
  }
})

import {
  createRoom,
  listPendingTurns,
  resetCollabDbForTests,
} from '../room-store'
import {
  listGlobalPendingTurns,
  openAttentionForMission,
  openAttentionForRoom,
  requestHumanAttention,
} from '../pending-turn-service'

describe('openAttentionForMission', () => {
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

  it('creates pending turn and dedups by assignment', async () => {
    // Seed the room so insertMessage / listPendingTurns hit real sqlite.
    createRoom({
      id: 'room-attn',
      title: 'Need human',
      missionId: 'mission-attn',
      taskId: 'mission-attn',
    } as any)

    // ensureRoom mock returns room-attn; createRoom may assign a different id.
    // Re-bind: call openAttention which uses mocked ensureRoom → room-attn.
    // First create a room with fixed id via raw create then override mock.
    const room = createRoom({
      title: 'Need human',
      missionId: 'mission-attn',
      taskId: 'mission-attn',
    })

    const { ensureRoomForMission } = await import('../ensure-room-for-mission')
    vi.mocked(ensureRoomForMission).mockResolvedValue({
      room,
      created: false,
    })

    const first = await openAttentionForMission({
      missionId: 'mission-attn',
      assignmentId: 'asg-1',
      requestedBy: 'developer',
      kind: 'needs_input',
      reason: 'Need API key',
      nextAction: 'Provide the key',
    })
    expect(first.status).toBe('pending')
    expect(first.options?.length).toBeGreaterThan(0)

    const second = await openAttentionForMission({
      missionId: 'mission-attn',
      assignmentId: 'asg-1',
      requestedBy: 'developer',
      kind: 'needs_input',
      reason: 'Need API key again',
    })
    expect(second.id).toBe(first.id)

    const open = listPendingTurns(first.roomId, { status: 'pending' })
    expect(open).toHaveLength(1)

    const global = listGlobalPendingTurns({ status: 'pending' })
    expect(global.some((t) => t.id === first.id)).toBe(true)
  })

  it('openAttentionForRoom dedups same reason', async () => {
    const room = createRoom({ title: 'Ad hoc' })
    const a = await openAttentionForRoom({
      roomId: room.id,
      requestedBy: 'bot',
      kind: 'needs_input',
      reason: 'same reason',
    })
    const b = await requestHumanAttention({
      room,
      requestedBy: 'bot',
      kind: 'needs_input',
      reason: 'same reason',
    })
    expect(a!.id).toBe(b.id)
  })
})
