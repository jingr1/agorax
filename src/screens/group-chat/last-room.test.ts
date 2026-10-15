import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearLastRoom,
  readLastRoom,
  resolveRoomToOpen,
  writeLastRoom,
} from './last-room'

describe('last-room', () => {
  beforeEach(() => {
    clearLastRoom()
    // Force clear even if clearLastRoom was scoped
    try {
      window.localStorage.removeItem('hermes-group-chat-last-room')
    } catch {
      // ignore
    }
  })

  it('round-trips the last room id', () => {
    writeLastRoom('room_abc')
    expect(readLastRoom()).toBe('room_abc')
  })

  it('resolveRoomToOpen prefers the remembered room when still present', () => {
    writeLastRoom('room_b')
    expect(
      resolveRoomToOpen([{ id: 'room_a' }, { id: 'room_b' }, { id: 'room_c' }]),
    ).toBe('room_b')
  })

  it('resolveRoomToOpen falls back to the first room when last is gone', () => {
    writeLastRoom('room_gone')
    expect(resolveRoomToOpen([{ id: 'room_a' }, { id: 'room_b' }])).toBe(
      'room_a',
    )
  })

  it('resolveRoomToOpen returns null when there are no rooms', () => {
    writeLastRoom('room_a')
    expect(resolveRoomToOpen([])).toBeNull()
  })

  it('clearLastRoom only clears when matching or unscoped', () => {
    writeLastRoom('room_a')
    clearLastRoom('room_b')
    expect(readLastRoom()).toBe('room_a')
    clearLastRoom('room_a')
    expect(readLastRoom()).toBeNull()
  })
})
