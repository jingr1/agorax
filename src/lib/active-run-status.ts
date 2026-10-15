export type ActiveRunStatus =
  | 'accepted'
  | 'active'
  | 'handoff'
  | 'stalled'
  | 'complete'
  | 'error'

// A run that hasn't been touched in this long is considered orphaned (e.g.
// the agent process crashed, the network dropped silently, or the user
// navigated away during a `handoff` that never resolved). Treating these as
// "active" makes every chat re-open show a phantom "Thinking…" indicator
// until the client-side failsafe clears it.
export const STALE_RUN_THRESHOLD_MS = 5 * 60 * 1000

export const ACTIVE_RUN_STATUSES = new Set<ActiveRunStatus>([
  'accepted',
  'active',
  'handoff',
])

export function isActiveRunStatus(
  status: ActiveRunStatus,
  updatedAt: number,
  now = Date.now(),
): boolean {
  if (!ACTIVE_RUN_STATUSES.has(status)) return false
  return now - updatedAt < STALE_RUN_THRESHOLD_MS
}
