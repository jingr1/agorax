import type { AgentActivitySessionGoalState } from "../types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import { projectSessionGoalControl } from "./sessionGoalControl.projection.ts";
import type {
  SessionGoalControlOperation,
  SessionGoalControlState
} from "./sessionGoalControl.types.ts";
import { validateSessionGoalControlResult } from "./sessionGoalControl.validation.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const DEFINITIVE_FAILURE_CODES = new Set([
  "invalid_request",
  "method_not_allowed",
  "unauthorized",
  "workspace_not_found",
  "workspace_agent_not_found"
]);

interface SessionGoalControlReducerContext {
  deletedSessionIds: Readonly<Record<string, true>>;
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
}

export function createInitialSessionGoalControlState(): SessionGoalControlState {
  return { operationsBySessionId: {} };
}

export function sessionGoalControlReducer(
  state: SessionGoalControlState,
  intent: EngineIntent,
  context: SessionGoalControlReducerContext
): EngineReducerResult<SessionGoalControlState> {
  switch (intent.type) {
    case "goal/controlRequested":
      return requestGoalControl(state, intent, context);
    case "engine/commandResult":
      return intent.commandType === "goal/control"
        ? settleGoalControl(state, intent, context)
        : unchanged(state);
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
    default:
      return unchanged(state);
  }
}

function requestGoalControl(
  state: SessionGoalControlState,
  intent: Extract<EngineIntent, { type: "goal/controlRequested" }>,
  context: SessionGoalControlReducerContext
): EngineReducerResult<SessionGoalControlState> {
  const agentSessionId = intent.agentSessionId.trim();
  const clientSubmitId = intent.clientSubmitId.trim();
  const commandId = intent.commandId.trim();
  const workspaceId = intent.workspaceId.trim();
  const objective = intent.objective?.trim() || undefined;
  const session = context.sessionsById[agentSessionId];
  const current = state.operationsBySessionId[agentSessionId];
  if (
    !agentSessionId ||
    !clientSubmitId ||
    !commandId ||
    !workspaceId ||
    !session ||
    session.workspaceId !== workspaceId ||
    context.deletedSessionIds[agentSessionId] ||
    current?.status === "pending" ||
    (intent.action === "set" && !objective)
  ) {
    return unchanged(state);
  }
  const currentGoal =
    current?.status === "unknown" || current?.status === "accepted"
      ? current.optimisticGoal
      : (session.goal ?? null);
  const optimisticGoal = projectSessionGoalControl(
    currentGoal,
    intent.action,
    objective
  );
  const operation: SessionGoalControlOperation = {
    action: intent.action,
    agentSessionId,
    clientSubmitId,
    commandId,
    errorCode: null,
    errorMessage: null,
    errorReason: null,
    ...(objective ? { objective } : {}),
    operationId: null,
    optimisticGoal,
    requestedAtUnixMs: intent.requestedAtUnixMs,
    resultState: null,
    status: "pending",
    workspaceId
  };
  return {
    commands: [
      {
        action: intent.action,
        agentSessionId,
        clientSubmitId,
        commandId,
        correlationId: clientSubmitId,
        ...(objective ? { objective } : {}),
        timeoutMs: intent.timeoutMs,
        type: "goal/control",
        workspaceId
      }
    ],
    state: replaceOperation(state, operation)
  };
}

function settleGoalControl(
  state: SessionGoalControlState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>,
  context: SessionGoalControlReducerContext
): EngineReducerResult<SessionGoalControlState> {
  const operation = Object.values(state.operationsBySessionId).find(
    (candidate) => candidate.commandId === intent.commandId
  );
  if (!operation) return unchanged(state);
  if (
    intent.outcome === "succeeded" &&
    intent.resultContract === "goal-control-v1"
  ) {
    const validation = validateSessionGoalControlResult(
      intent.value,
      operation
    );
    if (validation) {
      // Goal-control responses can race turn/session bumps that raise
      // updatedAtUnixMs while the RPC is in flight. Force the follow-up
      // projection to be at least as new as the live canonical Session so
      // shouldUseIncomingSession accepts an authoritative clear/set goal.
      const currentSession =
        context.sessionsById[operation.agentSessionId] ?? null;
      const session = {
        ...validation.session,
        messageVersion: Math.max(
          validation.session.messageVersion ?? 0,
          currentSession?.messageVersion ?? 0
        ),
        updatedAtUnixMs: Math.max(
          validation.session.updatedAtUnixMs ?? 0,
          currentSession?.updatedAtUnixMs ?? 0,
          currentSession?.lastEventUnixMs ?? 0,
          operation.requestedAtUnixMs
        )
      };
      const followUpIntents: EngineIntent[] = [
        { session, type: "session/upserted" }
      ];
      // Clears must win even when a concurrent Session upsert is still
      // rejected: patch the canonical Goal off-band so the banner cannot keep
      // a tombstoned Goal alive from a stale mid-flight projection.
      if (validation.goal === null && operation.action === "clear") {
        followUpIntents.push({
          agentSessionId: operation.agentSessionId,
          patch: { goal: null, updatedAtUnixMs: session.updatedAtUnixMs },
          type: "session/metadataPatched"
        });
      }
      return {
        commands: NO_COMMANDS,
        followUpIntents,
        state: replaceOperation(state, {
          ...operation,
          errorCode:
            validation.result.state?.syncStatus === "failed"
              ? "goal_control_failed"
              : null,
          errorMessage: validation.result.state?.lastError?.trim() || null,
          errorReason: null,
          operationId: validation.result.operationId?.trim() || null,
          optimisticGoal: validation.goal,
          resultState: validation.result.state
            ? cloneGoalState(validation.result.state)
            : null,
          status: statusFromGoalState(validation.result.state)
        })
      };
    }
  }
  if (intent.outcome === "failed") {
    const errorCode = intent.errorCode?.trim() || null;
    const errorReason = intent.errorReason?.trim() || null;
    const definitive =
      (errorCode !== null && DEFINITIVE_FAILURE_CODES.has(errorCode)) ||
      (errorReason !== null && DEFINITIVE_FAILURE_CODES.has(errorReason));
    return {
      commands: NO_COMMANDS,
      state: replaceOperation(state, {
        ...operation,
        errorCode,
        errorMessage: intent.errorMessage?.trim() || null,
        errorReason,
        status: definitive ? "failed" : "unknown"
      })
    };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceOperation(state, {
      ...operation,
      errorCode:
        intent.outcome === "succeeded"
          ? "invalid_command_result"
          : intent.errorCode?.trim() || null,
      errorMessage: intent.errorMessage?.trim() || null,
      errorReason: intent.errorReason?.trim() || null,
      status: "unknown"
    })
  };
}

function removeSession(
  state: SessionGoalControlState,
  rawAgentSessionId: string
): EngineReducerResult<SessionGoalControlState> {
  const agentSessionId = rawAgentSessionId.trim();
  if (!state.operationsBySessionId[agentSessionId]) return unchanged(state);
  const operationsBySessionId = { ...state.operationsBySessionId };
  delete operationsBySessionId[agentSessionId];
  return { commands: NO_COMMANDS, state: { operationsBySessionId } };
}

function statusFromGoalState(
  state: AgentActivitySessionGoalState | null | undefined
): SessionGoalControlOperation["status"] {
  switch (state?.syncStatus) {
    case "pending":
    case "applying":
      return "accepted";
    case "failed":
      return "failed";
    case "diverged":
    case "unknown":
      return "unknown";
    default:
      return "succeeded";
  }
}

function replaceOperation(
  state: SessionGoalControlState,
  operation: SessionGoalControlOperation
): SessionGoalControlState {
  return {
    operationsBySessionId: {
      ...state.operationsBySessionId,
      [operation.agentSessionId]: operation
    }
  };
}

function cloneGoalState(
  state: NonNullable<SessionGoalControlOperation["resultState"]>
): NonNullable<SessionGoalControlOperation["resultState"]> {
  return {
    ...state,
    ...(state.desired ? { desired: { ...state.desired } } : {}),
    ...(state.observed ? { observed: { ...state.observed } } : {}),
    lastEvidence: { ...state.lastEvidence }
  };
}

function unchanged(
  state: SessionGoalControlState
): EngineReducerResult<SessionGoalControlState> {
  return { commands: NO_COMMANDS, state };
}
