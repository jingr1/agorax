import { useEffect, useRef } from 'react'
import {
  isActiveRunStatus,
  type ActiveRunStatus,
} from '@/lib/active-run-status'
import { useChatStore } from '../../../stores/chat-store'

type ActiveRunResponse = {
  ok: boolean
  run: {
    runId: string
    status: ActiveRunStatus
    sessionKey: string
    startedAt: number
    updatedAt?: number
  } | null
}

const ACTIVE_RUN_CHECK_TIMEOUT_MS = 2000

/**
 * Remount reconcile against `/active-run`.
 *
 * - Live run → leave waiting alone (send-path latch may already be set).
 *   Do **not** `setSessionWaiting` — that was the old spinner entry and would
 *   re-arm 5s poll / history refetch. Busy chrome is Engine `turnBusy` only.
 * - No live run → clear orphan waiting + streamingState.
 */
export type ActiveRunRemountAction = 'leave' | 'clear-orphan'

export function decideActiveRunRemountAction(
  run: ActiveRunResponse['run'],
): ActiveRunRemountAction {
  if (
    run &&
    isActiveRunStatus(run.status, run.updatedAt ?? run.startedAt)
  ) {
    return 'leave'
  }
  return 'clear-orphan'
}

/**
 * On mount, reconcile this session against the server active-run registry.
 *
 * Closes the remount gap where Zustand still has waiting/streaming after the
 * server run is already gone (or Abort timed out the check). Does **not**
 * promote a live run into `waitingForResponse` — that latch is send/recovery
 * only; UI busy is Engine-owned.
 */
export function useActiveRunCheck({
  sessionKey,
  enabled,
  onCheckComplete,
}: {
  sessionKey: string
  enabled: boolean
  onCheckComplete?: () => void
}): void {
  const hasCheckedRef = useRef(false)
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey
  const onCompleteRef = useRef(onCheckComplete)
  onCompleteRef.current = onCheckComplete

  useEffect(() => {
    if (!enabled || !sessionKey || sessionKey === 'new') return
    if (hasCheckedRef.current) return
    hasCheckedRef.current = true

    const controller = new AbortController()
    let settled = false

    const settle = () => {
      if (settled) return
      settled = true
      onCompleteRef.current?.()
    }

    const clearOrphan = (key: string) => {
      const store = useChatStore.getState()
      if (store.isSessionWaiting(key)) {
        store.clearSessionWaiting(key)
      }
      store.clearStreamingSession(key)
    }

    // Timeout: if the API check doesn't complete in time, assume the run is
    // dead and clear orphan waiting/streaming — never set waiting on Abort.
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settle()
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
      clearOrphan(sessionKeyRef.current)
    }, ACTIVE_RUN_CHECK_TIMEOUT_MS)

    async function check() {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionKey)}/active-run`,
          { signal: controller.signal },
        )
        if (!response.ok) return finishCheck()

        const data = (await response.json()) as ActiveRunResponse
        if (!data.ok) return finishCheck()

        if (decideActiveRunRemountAction(data.run) === 'clear-orphan') {
          clearOrphan(sessionKey)
        }
        // Live run: leave waiting as-is. Engine/SSE owns busy + settle.
      } catch {
        // Network error or abort — ignore; timeout already clears orphans.
      } finally {
        finishCheck()
      }
    }

    function finishCheck() {
      window.clearTimeout(timeoutId)
      settle()
    }

    void check()

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [sessionKey, enabled])

  // Reset check flag when session changes
  useEffect(() => {
    hasCheckedRef.current = false
  }, [sessionKey])
}
