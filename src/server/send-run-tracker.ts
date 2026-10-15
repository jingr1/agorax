/**
 * In-memory registry of live /api/send-stream turns.
 *
 * Chat Stop must be able to hard-abort the upstream Hermes gateway request even
 * when the browser has lost its AbortController (handoff / remount / stale UI).
 * Persisted run-store rows alone cannot do that — only these live handles can.
 */

export type ActiveSendRunHandle = {
  runId: string
  sessionKey: string
  abortUpstream: () => void
}

const ACTIVE_RUNS_KEY = '__claude_active_send_runs__' as const
const ACTIVE_HANDLES_KEY = '__agorax_active_send_run_handles__' as const

function getActiveRuns(): Set<string> {
  const globalValue = globalThis as typeof globalThis & {
    [ACTIVE_RUNS_KEY]?: Set<string>
  }
  if (!globalValue[ACTIVE_RUNS_KEY]) {
    globalValue[ACTIVE_RUNS_KEY] = new Set<string>()
  }
  return globalValue[ACTIVE_RUNS_KEY]
}

function getActiveHandles(): Map<string, ActiveSendRunHandle> {
  const globalValue = globalThis as typeof globalThis & {
    [ACTIVE_HANDLES_KEY]?: Map<string, ActiveSendRunHandle>
  }
  if (!globalValue[ACTIVE_HANDLES_KEY]) {
    globalValue[ACTIVE_HANDLES_KEY] = new Map()
  }
  return globalValue[ACTIVE_HANDLES_KEY]
}

export function registerActiveSendRun(
  runId: string,
  options?: {
    sessionKey?: string | null
    abortUpstream?: () => void
  },
): void {
  if (!runId) return
  getActiveRuns().add(runId)
  const sessionKey = options?.sessionKey?.trim() || ''
  const abortUpstream = options?.abortUpstream
  if (!abortUpstream && !sessionKey) return

  const handles = getActiveHandles()
  const previous = handles.get(runId)
  handles.set(runId, {
    runId,
    sessionKey: sessionKey || previous?.sessionKey || '',
    abortUpstream: abortUpstream ?? previous?.abortUpstream ?? (() => {}),
  })
}

export function unregisterActiveSendRun(runId: string): void {
  if (!runId) return
  getActiveRuns().delete(runId)
  getActiveHandles().delete(runId)
}

export function hasActiveSendRun(runId: string | null | undefined): boolean {
  if (!runId) return false
  return getActiveRuns().has(runId)
}

export function getActiveSendRunHandle(
  runId: string | null | undefined,
): ActiveSendRunHandle | null {
  if (!runId) return null
  return getActiveHandles().get(runId) ?? null
}

export function listActiveSendRunHandlesForSession(
  sessionKey: string,
): Array<ActiveSendRunHandle> {
  const trimmed = sessionKey.trim()
  if (!trimmed) return []
  const out: Array<ActiveSendRunHandle> = []
  for (const handle of getActiveHandles().values()) {
    if (handle.sessionKey === trimmed) out.push(handle)
  }
  return out
}

/** Abort one live send-stream upstream. Returns true when a handle existed. */
export function interruptActiveSendRun(runId: string): boolean {
  const trimmed = runId.trim()
  if (!trimmed) return false
  const handle = getActiveHandles().get(trimmed)
  if (!handle) return false
  try {
    handle.abortUpstream()
  } catch {
    // Best-effort: the request may already be closing.
  }
  return true
}

/**
 * Abort every live send-stream bound to a session (concurrent overlaps included).
 * Returns the runIds that had a live abort handle.
 */
export function interruptActiveSendRunsForSession(
  sessionKey: string,
): Array<string> {
  const handles = listActiveSendRunHandlesForSession(sessionKey)
  const interrupted: Array<string> = []
  for (const handle of handles) {
    try {
      handle.abortUpstream()
      interrupted.push(handle.runId)
    } catch {
      // Best-effort.
    }
  }
  return interrupted
}

/** Test helper: drop all live handles. */
export function resetActiveSendRunsForTests(): void {
  getActiveRuns().clear()
  getActiveHandles().clear()
}
