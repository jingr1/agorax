import type {
  AgentActivityDurableMessage,
  AgentActivityInteraction,
  AgentActivitySessionDetailSnapshot
} from "@agorax/agent-activity-core";
import type { DaemonSessionActivityResponse } from "./daemonDtos.ts";
import {
  agentActivityInteractionFromDaemonInteraction,
  agentActivityMessageFromDaemonMessage,
  agentActivitySessionFromDaemonSession,
  agentActivityTurnFromDaemonTurn,
  type AgentActivitySessionMappingOptions
} from "./mappers.ts";

/**
 * The daemon's GET .../activity aggregate mapped as one value: canonical
 * Session, Turns, Messages, and Interactions. Extends the core detail
 * snapshot with the message and interaction collections the daemon ships in
 * the same response, so hosts can dispatch one `session/detailSnapshotReceived`
 * intent without dropping the hydration payload.
 */
export interface AgentActivityDaemonActivityDetail
  extends AgentActivitySessionDetailSnapshot {
  workspaceId: string;
  messages: AgentActivityDurableMessage[];
  interactions: AgentActivityInteraction[];
}

/**
 * Maps one authoritative daemon activity response without performing
 * transport or dispatch work. The daemon response has no projection
 * discriminator: a successful read is always the full aggregate, and
 * lifecycle capabilities are never projected, so the snapshot is
 * `authoritative` with `lifecycleCapabilitiesProjected: false`.
 *
 * The aggregate is validated atomically: a mismatched root Session, a Turn,
 * Message, or Interaction owned by another Session fails the whole mapping so
 * root and child state cannot become observably half-applied.
 */
export function agentActivitySessionDetailFromDaemon(
  workspaceId: string,
  expectedAgentSessionId: string,
  activity: DaemonSessionActivityResponse,
  options: AgentActivitySessionMappingOptions
): AgentActivityDaemonActivityDetail {
  assertDaemonActivityContract(expectedAgentSessionId, activity);
  // The daemon serializes empty Go slices as null; treat null/undefined as an
  // empty aggregate (assertDaemonActivityContract still rejects non-array
  // shapes such as strings or numbers).
  const turns = (activity.turns ?? []).map(agentActivityTurnFromDaemonTurn);
  const interactions = (activity.interactions ?? []).map(
    agentActivityInteractionFromDaemonInteraction
  );
  const messages = (activity.messages ?? []).map((message) =>
    agentActivityMessageFromDaemonMessage(workspaceId, message)
  );
  const latestTurn =
    [...turns].sort(
      (left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs
    )[0] ?? null;
  const session = agentActivitySessionFromDaemonSession(
    workspaceId,
    activity.session,
    { ...options, lifecycleCapabilitiesProjected: false }
  );
  return {
    projection: "authoritative",
    lifecycleCapabilitiesProjected: false,
    workspaceId,
    session: {
      ...session,
      activeTurn:
        (session.activeTurnId
          ? turns.find((turn) => turn.turnId === session.activeTurnId)
          : undefined) ?? null,
      latestTurn,
      latestTurnInteractions: latestTurn
        ? interactions.filter(
            (interaction) => interaction.turnId === latestTurn.turnId
          )
        : [],
      pendingInteractions: interactions.filter(
        (interaction) => interaction.status === "pending"
      )
    },
    childSessions: [],
    turns,
    messages,
    interactions
  };
}

function assertDaemonActivityContract(
  expectedAgentSessionId: string,
  activity: DaemonSessionActivityResponse
): void {
  const expectedId = trimmedString(expectedAgentSessionId);
  const rootId = trimmedString(activity.session?.ID);
  if (!expectedId || rootId !== expectedId) {
    throw detailContractError(
      `root Session id ${JSON.stringify(rootId)} does not match requested id ${JSON.stringify(expectedId)}`
    );
  }
  // null/undefined aggregates are allowed (empty Go slices serialize as null
  // and are coerced by the caller); present-but-non-array shapes fail closed.
  if (activity.turns != null && !Array.isArray(activity.turns)) {
    throw detailContractError("turns must be an authoritative array");
  }
  if (activity.messages != null && !Array.isArray(activity.messages)) {
    throw detailContractError("messages must be an authoritative array");
  }
  if (activity.interactions != null && !Array.isArray(activity.interactions)) {
    throw detailContractError("interactions must be an authoritative array");
  }
  for (const turn of activity.turns ?? []) {
    const turnId = trimmedString(turn.TurnID);
    if (!turnId || trimmedString(turn.AgentSessionID) !== rootId) {
      throw detailContractError(
        `Turn ${JSON.stringify(turnId)} must be owned by requested Session ${JSON.stringify(rootId)}`
      );
    }
  }
  for (const message of activity.messages ?? []) {
    const messageId = trimmedString(message.MessageID);
    if (!messageId || trimmedString(message.AgentSessionID) !== rootId) {
      throw detailContractError(
        `Message ${JSON.stringify(messageId)} must be owned by requested Session ${JSON.stringify(rootId)}`
      );
    }
  }
  for (const interaction of activity.interactions ?? []) {
    const requestId = trimmedString(interaction.RequestID);
    if (!requestId || trimmedString(interaction.AgentSessionID) !== rootId) {
      throw detailContractError(
        `Interaction ${JSON.stringify(requestId)} must be owned by requested Session ${JSON.stringify(rootId)}`
      );
    }
  }
}

function detailContractError(reason: string): Error {
  return new Error(`Daemon contract error: ${reason}`);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
