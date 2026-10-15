import { useCallback, useEffect, useRef, useState } from 'react'

type GroupChatEvent = {
  id: number
  event: string
  data: Record<string, unknown>
  receivedAt: number
}

const MAX_EVENTS = 50

const GROUP_CHAT_SSE_EVENTS = [
  'group_chat_reply',
  'group_chat_message',
  // Failure notes are also room_messages rows; without this the UI stays stale
  // until a full page reload even though sqlite already has the bubble.
  'group_chat_failed',
  'group_chat_human_attention',
  'group_chat_human_answered',
  'group_chat_human_dismissed',
  'group_chat_turn_started',
  'group_chat_settled',
  'group_chat_capped',
  'group_chat_turn_ended',
] as const

export function useGroupChatEvents(roomId?: string) {
  // Events are keyed by room so switching rooms restores that room's buffer
  // instead of wiping in-session turn status (Cap reached / settled / …).
  const [eventsByRoom, setEventsByRoom] = useState<
    Record<string, Array<GroupChatEvent>>
  >({})
  const [connected, setConnected] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  const pushEventForRoom = useCallback(
    (targetRoomId: string, event: string, data: Record<string, unknown>) => {
      setEventsByRoom((prev) => {
        const roomEvents = prev[targetRoomId] ?? []
        const next = [
          ...roomEvents,
          {
            id: roomEvents.length ? roomEvents[roomEvents.length - 1]!.id + 1 : 1,
            event,
            data,
            receivedAt: Date.now(),
          },
        ]
        if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS)
        return { ...prev, [targetRoomId]: next }
      })
    },
    [],
  )

  useEffect(() => {
    setConnected(false)
    if (!roomId) {
      esRef.current?.close()
      esRef.current = null
      return
    }

    // Capture the room this socket is bound to so late messages never land on
    // whatever room happens to be selected after a fast switch.
    const subscribedRoomId = roomId
    const url = `/api/chat-events?roomId=${encodeURIComponent(subscribedRoomId)}`
    const es = new EventSource(url)
    esRef.current = es

    es.addEventListener('connected', () => setConnected(true))
    es.addEventListener('error', () => setConnected(false))

    for (const eventName of GROUP_CHAT_SSE_EVENTS) {
      es.addEventListener(eventName, (e) => {
        pushEventForRoom(
          subscribedRoomId,
          eventName,
          JSON.parse((e as MessageEvent).data) as Record<string, unknown>,
        )
      })
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [roomId, pushEventForRoom])

  const events = roomId ? (eventsByRoom[roomId] ?? []) : []
  return { events, connected }
}
