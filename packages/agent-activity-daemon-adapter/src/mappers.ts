import type {
  AgentActivityDurableMessage,
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivitySessionGoal,
  AgentActivitySessionUsage,
  AgentActivityTurn,
  AgentActivityTurnOrigin,
  AgentActivityTurnOutcome
} from "@agorax/agent-activity-core";
import { agentActivitySessionCapabilitiesFromIds } from "@agorax/agent-activity-core";
import type {
  DaemonCanonicalInteraction,
  DaemonCanonicalMessage,
  DaemonCanonicalSession,
  DaemonCanonicalTurn,
  DaemonSessionGoal,
  DaemonSessionUsage
} from "./daemonDtos.ts";
import { agentActivityCapabilityReferencesFromDaemon } from "./capabilityReferences.ts";

export interface AgentActivitySessionMappingOptions {
  currentUserId: string;
  lifecycleCapabilitiesProjected?: boolean;
}

export function agentActivitySessionFromDaemonSession(
  workspaceId: string,
  session: DaemonCanonicalSession,
  options: AgentActivitySessionMappingOptions
): AgentActivitySession {
  assertDaemonSessionContract(session);
  const createdAtUnixMs = session.CreatedAtUnixMS;
  const updatedAtUnixMs = session.UpdatedAtUnixMS;
  return {
    workspaceId,
    agentSessionId: session.ID,
    kind: session.Kind as AgentActivitySession["kind"],
    rootAgentSessionId: session.RootAgentSessionID || null,
    rootTurnId: session.RootTurnID || null,
    parentAgentSessionId: session.ParentAgentSessionID || null,
    parentTurnId: session.ParentTurnID || null,
    parentToolCallId: session.ParentToolCallID || null,
    agentTargetId: session.AgentTargetID || null,
    provider: session.Provider,
    providerSessionId: session.ProviderSessionID || null,
    // daemon field: UserID — canonical sessions carry their own user identity.
    userId: session.UserID || options.currentUserId,
    // daemon field: Model.
    model: session.Model || null,
    cwd: session.Cwd || "/",
    railSectionKey: session.RailSectionKey,
    title: session.Title ?? "",
    activeTurnId: session.ActiveTurnID || null,
    // Resolved by agentActivitySessionDetailFromDaemon, which owns the Turns.
    activeTurn: null,
    latestTurn: null,
    latestTurnInteractions: [],
    pendingInteractions: [],
    settings: cloneSerializable(session.Settings ?? {}),
    // TODO(daemon-endpoint): canonical Session JSON carries no permission
    // config; the REST surface does not expose one.
    permissionConfig: { configurable: false, modes: [] },
    // CapabilitySnapshot wire uses json:"values".
    capabilities: session.Capabilities?.values?.length
      ? agentActivitySessionCapabilitiesFromIds(session.Capabilities.values)
      : null,
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    ...(options.lifecycleCapabilitiesProjected === undefined
      ? {}
      : {
          lifecycleCapabilitiesProjected:
            options.lifecycleCapabilitiesProjected === true
        }),
    // TODO(daemon-endpoint): fork lineage lives in dedicated daemon tables and
    // is not projected into the canonical Session JSON.
    forkedFrom: null,
    usage: sessionUsageFromDaemon(session.Metadata?.usage),
    goal: sessionGoalFromDaemon(session.Metadata?.goal),
    // TODO(daemon-endpoint): goalSyncState and AgoraxModeActivation are not
    // projected by the daemon REST surface.
    goalSyncState: null,
    agoraxModeActivation: null,
    imported: session.Metadata?.imported ?? false,
    visible: session.Metadata?.visible ?? true,
    // Provider session id present ⇒ the runtime can attempt resume.
    resumable: Boolean(session.ProviderSessionID?.trim()),
    messageVersion: session.MessageVersion,
    lastEventUnixMs: session.LastEventUnixMS || updatedAtUnixMs,
    startedAtUnixMs: session.StartedAtUnixMS,
    endedAtUnixMs: positiveNumber(session.EndedAtUnixMS),
    pinnedAtUnixMs: positiveNumber(session.PinnedAtUnixMS),
    createdAtUnixMs,
    updatedAtUnixMs
  };
}

export function agentActivityTurnFromDaemonTurn(
  turn: DaemonCanonicalTurn
): AgentActivityTurn {
  const capabilityRefs = agentActivityCapabilityReferencesFromDaemon(
    turn.CapabilityRefs ?? undefined
  );
  const outcome = turn.Outcome ? parseTurnOutcome(turn.Outcome) : null;
  return {
    agentSessionId: turn.AgentSessionID,
    ...(capabilityRefs.length > 0 ? { capabilityRefs } : {}),
    providerForkBindingAvailable: turn.ProviderForkBindingAvailable,
    completedCommand: completedCommandFromDaemonTurn(turn),
    // daemon fields: flat ErrorMessage/ErrorCode instead of a nested error.
    error: daemonTurnError(turn),
    fileChanges: turn.FileChanges ? cloneSerializable(turn.FileChanges) : null,
    outcome,
    origin: parseTurnOrigin(turn.Origin),
    phase: parseTurnPhase(turn.Phase),
    // daemon fields: SourceGoal* provenance scalars.
    ...(turn.SourceGoalOperationID
      ? { sourceGoalOperationId: turn.SourceGoalOperationID }
      : {}),
    ...(turn.SourceGoalRevision !== 0
      ? { sourceGoalRevision: turn.SourceGoalRevision }
      : {}),
    ...(turn.SourceGoalRepairEpoch !== 0
      ? { sourceGoalRepairEpoch: turn.SourceGoalRepairEpoch }
      : {}),
    settledAtUnixMs: positiveNumber(turn.SettledAtUnixMS),
    startedAtUnixMs: turn.StartedAtUnixMS,
    turnId: turn.TurnID,
    updatedAtUnixMs: turn.UpdatedAtUnixMS
  };
}

export function agentActivityMessageFromDaemonMessage(
  workspaceId: string,
  message: DaemonCanonicalMessage
): AgentActivityDurableMessage {
  return {
    workspaceId,
    agentSessionId: message.AgentSessionID,
    completedAtUnixMs: positiveNumber(message.CompletedAtUnixMS) ?? undefined,
    kind: message.Kind,
    messageId: message.MessageID,
    occurredAtUnixMs: normalizedDaemonMessageOccurredAtUnixMs(message),
    payload: recordValue(message.Payload),
    role: message.Role,
    // daemon field: ID is the durable per-session row sequence.
    sequence: message.ID,
    ...(message.Semantics != null
      ? {
          semantics: {
            ...(message.Semantics.userVisibleAssistantResponse !== undefined
              ? {
                  userVisibleAssistantResponse:
                    message.Semantics.userVisibleAssistantResponse
                }
              : {}),
            ...(message.Semantics.turnSettling !== undefined
              ? { turnSettling: message.Semantics.turnSettling }
              : {}),
            ...(isNoticeCommand(message.Semantics.noticeCommand)
              ? { noticeCommand: message.Semantics.noticeCommand }
              : {}),
            ...(isNoticeCommandStatus(message.Semantics.noticeCommandStatus)
              ? { noticeCommandStatus: message.Semantics.noticeCommandStatus }
              : {})
          }
        }
      : {}),
    startedAtUnixMs: positiveNumber(message.StartedAtUnixMS) ?? undefined,
    createdAtUnixMs: positiveNumber(message.CreatedAtUnixMS) ?? undefined,
    status: message.Status || undefined,
    turnId: normalizedDaemonMessageTurnId(message),
    version: message.Version
  };
}

export function agentActivityInteractionFromDaemonInteraction(
  interaction: DaemonCanonicalInteraction
): AgentActivityInteraction {
  return {
    agentSessionId: interaction.AgentSessionID,
    createdAtUnixMs: interaction.CreatedAtUnixMS,
    input: interaction.Input ? cloneSerializable(interaction.Input) : null,
    kind: parseInteractionKind(interaction.Kind),
    metadata: interaction.Metadata
      ? cloneSerializable(interaction.Metadata)
      : null,
    output: interaction.Output ? cloneSerializable(interaction.Output) : null,
    requestId: interaction.RequestID,
    status: parseInteractionStatus(interaction.Status),
    toolName: interaction.ToolName || null,
    turnId: interaction.TurnID,
    updatedAtUnixMs: interaction.UpdatedAtUnixMS
  };
}

export function normalizedDaemonMessageTurnId(
  message: DaemonCanonicalMessage
): string | null {
  const turnId = message.TurnID?.trim() ?? "";
  return turnId || null;
}

export function normalizedDaemonMessageOccurredAtUnixMs(
  message: DaemonCanonicalMessage
): number {
  return (
    positiveNumber(message.OccurredAtUnixMS) ??
    positiveNumber(message.StartedAtUnixMS) ??
    positiveNumber(message.CompletedAtUnixMS) ??
    positiveNumber(message.CreatedAtUnixMS) ??
    positiveNumber(message.UpdatedAtUnixMS) ??
    positiveNumber(message.Version) ??
    1
  );
}

export function assertDaemonSessionContract(
  session: DaemonCanonicalSession
): void {
  const value = session as unknown as Record<string, unknown>;
  const missing = [
    "ID",
    "Kind",
    "Provider",
    "ActiveTurnID",
    "MessageVersion",
    "Metadata",
    "RailSectionKey"
  ].filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    throw new Error(
      `Daemon contract error: canonical session is missing required field(s): ${missing.join(", ")}`
    );
  }
  if (session.Kind !== "root" && session.Kind !== "child") {
    throw new Error(
      `Daemon contract error: canonical session kind ${JSON.stringify(session.Kind)} is invalid`
    );
  }
  if (
    typeof session.MessageVersion !== "number" ||
    !Number.isSafeInteger(session.MessageVersion) ||
    session.MessageVersion < 0
  ) {
    throw new Error(
      "Daemon contract error: canonical session MessageVersion must be a non-negative safe integer"
    );
  }
  if (
    !value.Metadata ||
    typeof value.Metadata !== "object" ||
    Array.isArray(value.Metadata)
  ) {
    throw new Error(
      "Daemon contract error: canonical session Metadata must be an object"
    );
  }
}

function sessionUsageFromDaemon(
  usage: DaemonSessionUsage | undefined
): AgentActivitySessionUsage | null {
  if (!usage) {
    return null;
  }
  return {
    contextWindow: usage.contextWindow
      ? {
          usedTokens: usage.contextWindow.usedTokens,
          totalTokens: usage.contextWindow.totalTokens
        }
      : null,
    quotas: (usage.quotas ?? []).map((quota) => ({
      quotaType: quota.quotaType,
      percentRemaining: quota.percentRemaining,
      resetsAtUnixMs: quota.resetsAtUnixMs ?? null
    }))
  };
}

const DAEMON_GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

function sessionGoalFromDaemon(
  goal: DaemonSessionGoal | undefined
): AgentActivitySessionGoal | null {
  if (!goal) {
    return null;
  }
  if (!DAEMON_GOAL_STATUSES.has(goal.status)) {
    throw new Error(
      `Daemon contract error: canonical session goal status ${JSON.stringify(goal.status)} is invalid`
    );
  }
  return {
    objective: goal.objective,
    status: goal.status as AgentActivitySessionGoal["status"],
    ...(goal.reason ? { reason: goal.reason } : {}),
    ...(goal.startedAtUnixMs !== undefined
      ? { startedAtUnixMs: goal.startedAtUnixMs }
      : {}),
    ...(goal.iterations !== undefined ? { iterations: goal.iterations } : {}),
    ...(goal.durationMs !== undefined ? { durationMs: goal.durationMs } : {}),
    ...(goal.tokens !== undefined ? { tokens: goal.tokens } : {})
  };
}

function daemonTurnError(
  turn: DaemonCanonicalTurn
): { code?: string; message: string } | null {
  const message = turn.ErrorMessage?.trim() ?? "";
  if (!message) {
    return null;
  }
  return {
    message: turn.ErrorMessage,
    ...(turn.ErrorCode?.trim() ? { code: turn.ErrorCode } : {})
  };
}

function completedCommandFromDaemonTurn(
  turn: DaemonCanonicalTurn
): AgentActivityTurn["completedCommand"] {
  const kind = turn.CompletedCommandKind?.trim() ?? "";
  const status = turn.CompletedCommandStatus?.trim() ?? "";
  if (!kind || !status) {
    return null;
  }
  if (
    kind !== "compact" &&
    kind !== "review" &&
    kind !== "undo" &&
    kind !== "goal"
  ) {
    throw new Error(
      `Daemon contract error: canonical turn completed command kind ${JSON.stringify(kind)} is invalid`
    );
  }
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "canceled"
  ) {
    throw new Error(
      `Daemon contract error: canonical turn completed command status ${JSON.stringify(status)} is invalid`
    );
  }
  return { kind, status };
}

const TURN_PHASES = new Set([
  "submitted",
  "running",
  "waiting",
  "settling",
  "settled"
]);

function parseTurnPhase(value: string): AgentActivityTurn["phase"] {
  if (!TURN_PHASES.has(value)) {
    throw new Error(
      `Daemon contract error: canonical turn phase ${JSON.stringify(value)} is invalid`
    );
  }
  return value as AgentActivityTurn["phase"];
}

function parseTurnOrigin(value: string): AgentActivityTurnOrigin {
  // Go zero-value Origin arrives as "". Treat blank as legacy so a settled
  // quota/rate-limit turn still maps — otherwise GET .../activity throws and
  // group-chat reconcile returns null (silent hang until soft timeout).
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "legacy_unknown";
  if (
    trimmed !== "user_prompt" &&
    trimmed !== "goal_arm" &&
    trimmed !== "goal_continuation" &&
    trimmed !== "provider_initiated" &&
    trimmed !== "legacy_unknown"
  ) {
    throw new Error(
      `Daemon contract error: canonical turn origin ${JSON.stringify(value)} is invalid`
    );
  }
  return trimmed as AgentActivityTurnOrigin;
}

function parseTurnOutcome(value: string): AgentActivityTurnOutcome {
  if (
    value !== "completed" &&
    value !== "failed" &&
    value !== "canceled" &&
    value !== "interrupted"
  ) {
    throw new Error(
      `Daemon contract error: canonical turn outcome ${JSON.stringify(value)} is invalid`
    );
  }
  return value;
}

function parseInteractionKind(
  value: string
): AgentActivityInteraction["kind"] {
  if (value !== "approval" && value !== "question" && value !== "plan") {
    throw new Error(
      `Daemon contract error: canonical interaction kind ${JSON.stringify(value)} is invalid`
    );
  }
  return value;
}

function parseInteractionStatus(
  value: string
): AgentActivityInteraction["status"] {
  if (value !== "pending" && value !== "answered" && value !== "superseded") {
    throw new Error(
      `Daemon contract error: canonical interaction status ${JSON.stringify(value)} is invalid`
    );
  }
  return value;
}

function isNoticeCommand(
  value: string | undefined
): value is "compact" | "review" | "undo" | "goal" {
  return (
    value === "compact" ||
    value === "review" ||
    value === "undo" ||
    value === "goal"
  );
}

function isNoticeCommandStatus(
  value: string | undefined
): value is "running" | "completed" | "failed" | "canceled" {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function cloneSerializable<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneSerializable(item)) as T;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneSerializable(item)])
  ) as T;
}
