/**
 * Shared hint so agents can re-fetch mission Spec after human edits.
 * Used by assignee briefs, swarm-dispatch wrappers, and managed startRun.
 */

export function workspaceLoopbackBaseUrl(): string {
  const port = process.env.PORT ?? process.env.VITE_PORT ?? '6734'
  return `http://127.0.0.1:${port}`
}

export function missionDetailUrl(missionId: string): string {
  return `${workspaceLoopbackBaseUrl()}/api/missions/${missionId}`
}

/** True when the prompt already carries a freshness / refresh contract. */
export function hasMissionSpecFreshnessHint(text: string): boolean {
  return (
    text.includes('## Spec freshness') ||
    text.includes('## Mission Spec freshness')
  )
}

/**
 * Append a Spec-freshness block unless one is already present.
 * Safe to call on every dispatch / startRun.
 */
export function appendMissionSpecFreshnessHint(
  task: string,
  missionId: string,
): string {
  const id = missionId.trim()
  if (!id || hasMissionSpecFreshnessHint(task)) return task
  const url = missionDetailUrl(id)
  return [
    task.trimEnd(),
    '',
    '## Spec freshness',
    'Assigned Task text may lag human edits to the mission Spec.',
    `Refresh authoritative title/spec/acceptanceCriteria with: curl -sS '${url}'`,
    'Prefer the API payload when it differs from the Spec embedded above.',
  ].join('\n')
}
