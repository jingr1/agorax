import {
  agentActivitySessionDetailFromDaemon,
  type AgentActivityDaemonActivityDetail,
  type DaemonSessionActivityResponse,
} from '@agorax/agent-activity-daemon-adapter'

export type ManagedAgentActivityDetail = AgentActivityDaemonActivityDetail

// Canonical sessions carry their own user identity; the daemon's UserID wins
// when present, so this fallback only surfaces for legacy rows.
const MANAGED_CHAT_USER_ID = 'agorax-managed-chat-user'

/**
 * Maps one daemon activity aggregate (the `activity` field of the managed
 * command responses) into the canonical detail snapshot the Engine consumes.
 * Fail closed: malformed aggregates yield `null` instead of a partial map.
 */
export function mapManagedAgentActivitySnapshot(
  value: unknown,
): ManagedAgentActivityDetail | null {
  const activity = asRecord(value)
  if (!activity) return null
  const workspaceId = readTrimmedString(activity.workspaceId)
  const expectedAgentSessionId = readTrimmedString(asRecord(activity.session)?.ID)
  if (!workspaceId || !expectedAgentSessionId) return null
  try {
    return agentActivitySessionDetailFromDaemon(
      workspaceId,
      expectedAgentSessionId,
      activity as unknown as DaemonSessionActivityResponse,
      { currentUserId: MANAGED_CHAT_USER_ID },
    )
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}
