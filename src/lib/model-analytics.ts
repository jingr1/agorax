/**
 * Canonical model identity for usage/analytics aggregation.
 *
 * Hermes `session_model_usage` may store the same logical model under
 * different strings (casing, provider prefix). Group on a normalized key;
 * keep a human-preferred id for display/tooltips.
 */

export function canonicalModelAnalyticsKey(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return 'unknown'
  const stripped = trimmed.includes('/')
    ? (trimmed.split('/').pop() ?? trimmed)
    : trimmed
  return stripped.toLowerCase().replace(/[-_.\s/]+/g, '')
}

/** Prefer ids with clearer casing (e.g. Kimi-K2.7-Code over kimi-k2.7-code). */
export function preferModelDisplayId(a: string, b: string): string {
  const score = (s: string) => {
    const upper = s.match(/[A-Z]/g)?.length ?? 0
    return upper * 10 + s.length
  }
  return score(a) >= score(b) ? a : b
}

export type TopModelAggregateRow = {
  id: string
  tokens: number
  calls: number
  cost: number
  sessions: number
}

export function mergeTopModelRows(
  rows: Array<TopModelAggregateRow>,
): Array<TopModelAggregateRow> {
  const map = new Map<string, TopModelAggregateRow>()
  for (const row of rows) {
    const key = canonicalModelAnalyticsKey(row.id)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { ...row })
      continue
    }
    map.set(key, {
      id: preferModelDisplayId(prev.id, row.id),
      tokens: prev.tokens + row.tokens,
      calls: prev.calls + row.calls,
      cost: prev.cost + row.cost,
      sessions: prev.sessions + row.sessions,
    })
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens)
}
