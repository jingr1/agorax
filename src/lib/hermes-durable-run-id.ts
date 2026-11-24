/**
 * Hermes durable assistant hosts use gateway run ids (`run_…` / non-UUID).
 * send-stream also mints a Workspace UUID solely for Stop / AbortController —
 * that token must never become `assistant:<uuid>` (Activity then only appears
 * after settle replace onto `assistant:run_*`).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isHermesDurableRunId(
  runId: string | null | undefined,
): boolean {
  const id = typeof runId === 'string' ? runId.trim() : ''
  if (!id) return false
  if (UUID_RE.test(id)) return false
  return true
}
