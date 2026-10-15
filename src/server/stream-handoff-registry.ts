/**
 * In-memory registry of chat runs whose upstream Hermes gateway request must
 * stay alive after the browser SSE leg closes (profile switch, refresh, or a
 * dropped proxy). Explicit Stop clears the entry and aborts upstream.
 */

const DETACHED_RUN_TTL_MS = 30 * 60 * 1000

const detachedRuns = new Map<string, number>()

function pruneExpired(now = Date.now()): void {
  for (const [runId, expiresAt] of detachedRuns) {
    if (expiresAt <= now) detachedRuns.delete(runId)
  }
}

export function markRunDetached(runId: string): void {
  const trimmed = runId.trim()
  if (!trimmed) return
  pruneExpired()
  detachedRuns.set(trimmed, Date.now() + DETACHED_RUN_TTL_MS)
}

export function isRunDetached(runId: string): boolean {
  const trimmed = runId.trim()
  if (!trimmed) return false
  pruneExpired()
  const expiresAt = detachedRuns.get(trimmed)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    detachedRuns.delete(trimmed)
    return false
  }
  return true
}

export function clearRunDetached(runId: string): void {
  const trimmed = runId.trim()
  if (!trimmed) return
  detachedRuns.delete(trimmed)
}

export type ClientDisconnectAction = 'abort_upstream' | 'detach_handoff'

export function resolveClientDisconnectAction(input: {
  runId: string | null | undefined
  isDetached?: (runId: string) => boolean
}): ClientDisconnectAction {
  const runId = input.runId?.trim()
  if (!runId) return 'abort_upstream'
  const check = input.isDetached ?? isRunDetached
  return check(runId) ? 'detach_handoff' : 'abort_upstream'
}
