import type { AgentActivityInteraction } from "./types.ts";

export function isSameInteractionIdentity(
  left: AgentActivityInteraction,
  right: AgentActivityInteraction
): boolean {
  return (
    left.agentSessionId === right.agentSessionId &&
    left.turnId === right.turnId &&
    left.requestId === right.requestId
  );
}

export function shouldUseIncomingInteraction(
  current: AgentActivityInteraction | undefined,
  incoming: AgentActivityInteraction
): boolean {
  if (!current) return true;
  if (incoming.updatedAtUnixMs < current.updatedAtUnixMs) return false;
  const currentTerminal = current.status !== "pending";
  const incomingTerminal = incoming.status !== "pending";
  if (currentTerminal && incoming.status !== current.status) return false;
  if (
    incoming.updatedAtUnixMs === current.updatedAtUnixMs &&
    currentTerminal !== incomingTerminal
  ) {
    return incomingTerminal;
  }
  return true;
}
