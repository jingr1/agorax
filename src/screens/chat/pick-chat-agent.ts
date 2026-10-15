/**
 * Pick a chat agent id that exists in the registry.
 * Prefer: remembered → first online/busy → first listed.
 * Returns null when the registry is empty (caller decides fallback).
 */
export function pickChatAgentId(
  agents: ReadonlyArray<{ agentId: string; status?: string }>,
  preferred?: string | null,
): string | null {
  if (agents.length === 0) return null

  const wanted = preferred?.trim()
  if (wanted && agents.some((agent) => agent.agentId === wanted)) {
    return wanted
  }

  const firstOnline = agents.find(
    (agent) => agent.status === 'online' || agent.status === 'busy',
  )
  return firstOnline?.agentId ?? agents[0]?.agentId ?? null
}
