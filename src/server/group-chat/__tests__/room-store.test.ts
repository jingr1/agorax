import { describe, it, expect, beforeEach } from 'vitest'
import {
  createRoom,
  addParticipant,
  getRoom,
  listRooms,
  listParticipants,
  insertMessage,
  getLatestMessages,
  updateRoom,
  deleteRoom,
  removeParticipant,
  findRoomByMissionId,
  resetCollabDbForTests,
} from '../room-store'

describe('room-store', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = resetCollabDbForTests()
  })

  it('creates and retrieves a room', () => {
    const room = createRoom({ title: 'Test Room', dbPath })
    expect(room.title).toBe('Test Room')
    expect(room.state).toBe('active')

    const fetched = getRoom(room.id, { dbPath })
    expect(fetched?.title).toBe('Test Room')
  })

  it('persists workspacePath and finds rooms by missionId', () => {
    const room = createRoom({
      title: 'WS',
      workspacePath: '/tmp/ws',
      dbPath,
    })
    expect(room.workspacePath).toBe('/tmp/ws')
    const missionRoom = createRoom({
      title: 'Mission room',
      missionId: 'mission-abc',
      workspacePath: '/tmp/mission-ws',
      dbPath,
    })
    expect(findRoomByMissionId('mission-abc', { dbPath })?.id).toBe(
      missionRoom.id,
    )
    expect(findRoomByMissionId('missing', { dbPath })).toBeNull()
    const updated = updateRoom(
      room.id,
      { workspacePath: '/tmp/ws2' },
      { dbPath },
    )
    expect(updated?.workspacePath).toBe('/tmp/ws2')
  })

  it('lists rooms ordered by updated_at', () => {
    const r1 = createRoom({ title: 'First', dbPath })
    const r2 = createRoom({ title: 'Second', dbPath })
    const rooms = listRooms({ dbPath })
    expect(rooms[0]!.id).toBe(r2.id)
    expect(rooms[1]!.id).toBe(r1.id)
  })

  it('updates room state', () => {
    const room = createRoom({ title: 'Test', dbPath })
    const updated = updateRoom(room.id, { state: 'needs_human' }, { dbPath })
    expect(updated?.state).toBe('needs_human')
  })

  it('deletes a room and cascades', () => {
    const room = createRoom({ title: 'Test', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'dev',
      dbPath,
    })
    deleteRoom(room.id, { dbPath })
    expect(getRoom(room.id, { dbPath })).toBeNull()
    expect(listParticipants(room.id, { dbPath })).toEqual([])
  })

  it('adds participants and excludes removed ones', () => {
    const room = createRoom({ title: 'Test', dbPath })
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
    expect(listParticipants(room.id, { dbPath }).length).toBe(2)
  })

  it('removes participants by slug and allows re-add', () => {
    const room = createRoom({ title: 'Test', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'architect',
      dbPath,
    })
    const removed = removeParticipant(room.id, 'architect', { dbPath })
    expect(removed?.participantId).toBe('architect')
    expect(
      listParticipants(room.id, { dbPath }).map((p) => p.participantId),
    ).toEqual([])
    // Re-add must revive instead of UNIQUE-failing on mention_name.
    const revived = addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'architect',
      dbPath,
    })
    expect(revived.removedAt).toBeNull()
    expect(
      listParticipants(room.id, { dbPath }).map((p) => p.participantId),
    ).toEqual(['architect'])
  })

  it('inserts and retrieves messages', () => {
    const room = createRoom({ title: 'Test', dbPath })
    addParticipant({
      roomId: room.id,
      kind: 'agent',
      participantId: 'dev',
      dbPath,
    })

    const msg = insertMessage({
      roomId: room.id,
      senderKind: 'agent',
      senderParticipantId: 'dev',
      senderName: 'Dev',
      content: 'hello',
      dbPath,
    })

    const messages = getLatestMessages(room.id, { limit: 10, dbPath })
    expect(messages[0]!.id).toBe(msg.id)
    expect(messages[0]!.content).toBe('hello')
  })
})
