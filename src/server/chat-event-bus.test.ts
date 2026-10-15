import { describe, expect, it, vi } from 'vitest'
import { publishChatEvent, subscribeToChatEvents } from './chat-event-bus'

describe('chat-event-bus', () => {
  it('filters by sessionKey when given a string filter', () => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents(
      (evt) => received.push(evt),
      'sess-1',
    )

    publishChatEvent('test', { sessionKey: 'sess-1', text: 'hello' })
    publishChatEvent('test', { sessionKey: 'sess-2', text: 'world' })
    publishChatEvent('test', { text: 'no-session' })

    unsubscribe()
    expect(received).toHaveLength(2)
    expect(received[0].data.text).toBe('hello')
    expect(received[1].data.text).toBe('no-session')
  })

  it('filters by roomId when given an object filter', () => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents((evt) => received.push(evt), {
      roomId: 'room-42',
    })

    publishChatEvent('room_event', { roomId: 'room-42', text: 'in-room' })
    publishChatEvent('room_event', { roomId: 'room-99', text: 'other-room' })
    publishChatEvent('room_event', { text: 'no-room' })

    unsubscribe()
    expect(received).toHaveLength(1)
    expect(received[0].data.text).toBe('in-room')
  })

  it('filters by scope when given an object filter', () => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents((evt) => received.push(evt), {
      scope: 'global',
    })

    publishChatEvent('agent_status', { scope: 'global', agentId: 'dev-1' })
    publishChatEvent('agent_status', { scope: 'room', agentId: 'dev-2' })
    publishChatEvent('agent_status', { agentId: 'dev-3' })

    unsubscribe()
    expect(received).toHaveLength(1)
    expect(received[0].data.agentId).toBe('dev-1')
  })

  it('combines sessionKey and roomId filters', () => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents((evt) => received.push(evt), {
      sessionKey: 'sess-1',
      roomId: 'room-42',
    })

    publishChatEvent('msg', {
      sessionKey: 'sess-1',
      roomId: 'room-42',
      text: 'both',
    })
    publishChatEvent('msg', {
      sessionKey: 'sess-1',
      roomId: 'room-99',
      text: 'wrong-room',
    })
    publishChatEvent('msg', {
      sessionKey: 'sess-2',
      roomId: 'room-42',
      text: 'wrong-session',
    })
    publishChatEvent('msg', { text: 'neither' })

    unsubscribe()
    expect(received).toHaveLength(1)
    expect(received[0].data.text).toBe('both')
  })

  it('does not filter when no filter provided', () => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents((evt) => received.push(evt))

    publishChatEvent('a', { sessionKey: 'x', roomId: 'y', scope: 'z' })
    publishChatEvent('b', {})

    unsubscribe()
    expect(received).toHaveLength(2)
  })
})
