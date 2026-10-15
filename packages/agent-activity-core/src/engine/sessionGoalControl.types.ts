import type {
  AgentActivityGoalControlAction,
  AgentActivityGoalControlResult,
  AgentActivitySessionGoal,
  AgentActivitySessionGoalState
} from "../types.ts";
import type { EngineExternalCommandBase } from "./types.ts";

export type SessionGoalControlStatus =
  | "pending"
  | "accepted"
  | "succeeded"
  | "failed"
  | "unknown";

export interface SessionGoalControlOperation {
  action: AgentActivityGoalControlAction;
  agentSessionId: string;
  clientSubmitId: string;
  commandId: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorReason: string | null;
  objective?: string;
  operationId: string | null;
  optimisticGoal: AgentActivitySessionGoal | null;
  requestedAtUnixMs: number;
  resultState: AgentActivitySessionGoalState | null;
  status: SessionGoalControlStatus;
  workspaceId: string;
}

export interface SessionGoalControlState {
  operationsBySessionId: Readonly<Record<string, SessionGoalControlOperation>>;
}

export type SessionGoalControlPresentationStatus =
  | SessionGoalControlStatus
  | "idle"
  | "pending_create";

export interface SessionGoalControlPresentation {
  agentSessionId: string | null;
  goal: AgentActivitySessionGoal | null;
  optimistic: boolean;
  status: SessionGoalControlPresentationStatus;
}

export interface SessionGoalControlSettlement {
  action: SessionGoalControlOperation["action"];
  agentSessionId: string;
  clientSubmitId: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorReason: string | null;
  status: Exclude<
    SessionGoalControlPresentationStatus,
    "idle" | "pending_create"
  >;
}

/**
 * Host-observable Goal state. The reducer's operation ledger deliberately
 * stays behind the Engine module seam. Both maps are sparse: callers use the
 * selectors for the default idle presentation when a Session has no Goal,
 * Goal operation, or Goal-bearing activation.
 */
export interface SessionGoalControlPublicState {
  presentationsBySessionId: Readonly<
    Record<string, SessionGoalControlPresentation>
  >;
  settlementsBySessionId: Readonly<
    Record<string, SessionGoalControlSettlement>
  >;
}

export interface SessionGoalControlRequestedIntent {
  action: AgentActivityGoalControlAction;
  agentSessionId: string;
  clientSubmitId: string;
  commandId: string;
  objective?: string;
  requestedAtUnixMs: number;
  timeoutMs: number;
  type: "goal/controlRequested";
  workspaceId: string;
}

export type SessionGoalControlIntent = SessionGoalControlRequestedIntent;

export interface SessionGoalControlCommand extends EngineExternalCommandBase {
  action: AgentActivityGoalControlAction;
  agentSessionId: string;
  clientSubmitId: string;
  correlationId: string;
  objective?: string;
  type: "goal/control";
  workspaceId: string;
}

export interface AgentSessionGoalControlEffectInput {
  action: AgentActivityGoalControlAction;
  agentSessionId: string;
  clientSubmitId: string;
  objective?: string;
  workspaceId: string;
}

export interface AgentSessionControlGoalInput {
  action: AgentActivityGoalControlAction;
  agentSessionId: string;
  clientSubmitId: string;
  objective?: string;
}

/**
 * Admission reports the identity the Engine actually used. An exact retry of
 * an outcome-unknown mutation keeps its original Host idempotency identity.
 */
export interface AgentSessionControlGoalAdmission {
  accepted: boolean;
  clientSubmitId: string;
}

export interface SessionGoalControlResultValidation {
  goal: AgentActivitySessionGoal | null;
  result: AgentActivityGoalControlResult;
  session: import("../sessionNormalization.ts").AgentActivitySessionInput;
}
