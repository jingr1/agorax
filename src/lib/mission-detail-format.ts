/**
 * Presentation helpers for Mission detail (timeline + task summary).
 */

export type MissionEventLike = {
  type: string
  at: number
  message?: string
  workerId?: string
  assignmentId?: string
  [key: string]: unknown
}

export type TimelineItem = {
  id: string
  title: string
  subtitle?: string
  at: number
  count?: number
}

/** Prefer a human message; fall back to type + worker. */
export function formatMissionEventTitle(event: MissionEventLike): string {
  const message =
    typeof event.message === 'string' ? event.message.trim() : ''
  if (message) return message
  const worker =
    typeof event.workerId === 'string' && event.workerId.trim()
      ? event.workerId.trim()
      : null
  return worker ? `${event.type} · ${worker}` : event.type
}

/**
 * Fold consecutive `continuation` events into one row with a count badge.
 * Other event types stay one-per-row. Newest-first input is preserved.
 */
export function buildTimelineFromEvents(
  events: Array<MissionEventLike>,
  runs: Array<{
    id: string
    agent_id: string
    status: string
    summary: string | null
    started_at: number | null
  }> = [],
): Array<TimelineItem> {
  const list: Array<TimelineItem> = []

  for (const run of runs) {
    list.push({
      id: `run-${run.id}`,
      title: `${run.agent_id} · ${run.status}`,
      subtitle: run.summary ?? undefined,
      at: run.started_at ?? 0,
    })
  }

  const sorted = [...events].sort((a, b) => b.at - a.at)
  let i = 0
  while (i < sorted.length) {
    const event = sorted[i]!
    if (event.type === 'continuation') {
      let j = i + 1
      while (j < sorted.length && sorted[j]!.type === 'continuation') j += 1
      const count = j - i
      const newest = event
      list.push({
        id: `continuation-${newest.at}-${i}`,
        title: formatMissionEventTitle(newest),
        subtitle:
          count > 1
            ? `${count} continuation events`
            : typeof newest.workerId === 'string'
              ? newest.workerId
              : undefined,
        at: newest.at,
        count: count > 1 ? count : undefined,
      })
      i = j
      continue
    }
    list.push({
      id: `${event.type}-${event.at}-${i}`,
      title: formatMissionEventTitle(event),
      subtitle:
        typeof event.workerId === 'string' ? event.workerId : undefined,
      at: event.at,
    })
    i += 1
  }

  return list.sort((a, b) => b.at - a.at)
}

/**
 * Short one-line summary from a stage brief / task body.
 * Skips `# Stage:` lines; prefers the first real heading or prose line.
 */
export function taskSummaryLine(task: string, maxLen = 100): string {
  const lines = task
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    if (/^#+\s*Stage\b/i.test(line)) continue
    if (/^#+\s*Spec\b/i.test(line)) continue
    const cleaned = line.replace(/^#+\s*/, '').trim()
    if (!cleaned) continue
    if (cleaned.length <= maxLen) return cleaned
    return `${cleaned.slice(0, maxLen - 1)}…`
  }
  const flat = task.replace(/\s+/g, ' ').trim()
  if (!flat) return '—'
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}…`
}
