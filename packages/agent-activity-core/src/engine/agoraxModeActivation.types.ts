import type {
  AgentActivityInitialAgoraxModeActivation,
  AgentActivityAgoraxModeActivation,
  AgentActivityAgoraxModeActivationSource,
  AgentActivityAgoraxModeActivationStatus
} from "../types.ts";

export interface AgoraxModeDraftIntentRecord {
  active: true;
  draftKey: string;
  occurredAtUnixMs: number;
  /** null = 未选择,交给 daemon 默认值。 */
  effect?: number | null;
  speed?: number | null;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity: number | null;
  source: "slash_command";
}

export interface AgoraxModePendingCreateRecord {
  agentSessionId: string;
  draftKey: string;
  initialActivation: AgentActivityInitialAgoraxModeActivation;
  reconcileCommandId: string | null;
  requestId: string;
  workspaceId: string;
}

export type AgoraxModeActivationUpdateStatus =
  | "inFlight"
  | "failed"
  | "uncertain";

export interface AgoraxModeActivationUpdateRecord {
  agentSessionId: string;
  commandId: string;
  errorCode: string | null;
  errorMessage: string | null;
  expectedRevision: number | null;
  effect?: number | null;
  speed?: number | null;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity: number | null;
  reconcileCommandId: string | null;
  requestedAtUnixMs: number;
  source: AgentActivityAgoraxModeActivationSource;
  status: AgentActivityAgoraxModeActivationStatus;
  updateStatus: AgoraxModeActivationUpdateStatus;
  workspaceId: string;
}

export interface AgoraxModeActivationState {
  activationsBySessionId: Readonly<
    Record<string, AgentActivityAgoraxModeActivation | null>
  >;
  draftsByKey: Readonly<Record<string, AgoraxModeDraftIntentRecord>>;
  pendingCreatesBySessionId: Readonly<
    Record<string, AgoraxModePendingCreateRecord>
  >;
  updatesBySessionId: Readonly<Record<string, AgoraxModeActivationUpdateRecord>>;
}

export interface AgoraxModeDraftSetIntent {
  type: "agoraxMode/draftSet";
  active: boolean;
  draftKey: string;
  occurredAtUnixMs: number;
  effect?: number | null;
  speed?: number | null;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity?: number | null;
}

export interface AgoraxModeActivationUpdateRequestedIntent {
  type: "agoraxMode/updateRequested";
  agentSessionId: string;
  commandId: string;
  effect?: number | null;
  speed?: number | null;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity?: number | null;
  requestedAtUnixMs: number;
  source: AgentActivityAgoraxModeActivationSource;
  status: AgentActivityAgoraxModeActivationStatus;
  workspaceId: string;
}

export type AgoraxModeActivationIntent =
  | AgoraxModeDraftSetIntent
  | AgoraxModeActivationUpdateRequestedIntent;

export interface AgoraxModeActivationUpdateCommand {
  type: "agoraxMode/update";
  agentSessionId: string;
  commandId: string;
  expectedRevision?: number;
  effect?: number;
  speed?: number;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity?: number;
  source: AgentActivityAgoraxModeActivationSource;
  status: AgentActivityAgoraxModeActivationStatus;
  timeoutMs?: number;
  workspaceId: string;
}

export type AgoraxModeActivationCommand = AgoraxModeActivationUpdateCommand;
