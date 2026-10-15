'use client'

import { useEffect, useRef, useState } from 'react'
import type { CollabEvent } from '@/lib/mission-control-api'
import { subscribeCollabEvents } from '@/lib/mission-control-api'

export type UseCollabStreamOptions = {
  scope?: string
  roomId?: string
  sessionKey?: string
  enabled?: boolean
}

export function useCollabStream(options: UseCollabStreamOptions = {}) {
  const { scope, roomId, sessionKey, enabled = true } = options
  const [events, setEvents] = useState<Array<CollabEvent>>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled) return
    setConnected(true)
    setError(null)

    unsubscribeRef.current = subscribeCollabEvents(
      { scope, roomId, sessionKey },
      (event) => {
        setEvents((prev) => [...prev.slice(-199), event])
      },
      (err) => {
        setError(err)
        setConnected(false)
      },
    )

    return () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [scope, roomId, sessionKey, enabled])

  return { events, connected, error }
}
