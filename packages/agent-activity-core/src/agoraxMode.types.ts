export interface AgentActivityCapabilityReference {
  capability: "agorax";
  source: "slash_command";
}

export type AgentActivityAgoraxModeActivationStatus = "active" | "inactive";
export type AgentActivityAgoraxModeActivationSource =
  | "slash_command"
  | "badge_remove";

export interface AgentActivityAgoraxModeActivationRevision {
  activationId: string;
  revision: number;
  status: AgentActivityAgoraxModeActivationStatus;
  source: AgentActivityAgoraxModeActivationSource;
  /**
   * Outcome-quality preference. Optional while legacy revision producers are
   * supported; consumers fall back to orchestrationIntensity.
   */
  effect?: number;
  /**
   * Completion-speed preference. Optional while legacy revision producers are
   * supported; consumers use the balanced default when absent.
   */
  speed?: number;
  /**
   * Legacy single-axis alias of effect.
   *
   * @deprecated Use effect and speed.
   */
  orchestrationIntensity: number;
  createdAtUnixMs: number;
}

export interface AgentActivityAgoraxModeActivation {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  status: AgentActivityAgoraxModeActivationStatus;
  currentRevision: AgentActivityAgoraxModeActivationRevision;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface AgentActivityInitialAgoraxModeActivation {
  status: "active";
  source: "slash_command";
  effect?: number | null;
  speed?: number | null;
  /**
   * Legacy single-axis alias of effect. Ignored when effect is present.
   *
   * @deprecated Use effect and speed.
   */
  orchestrationIntensity?: number | null;
}

export interface AgentActivityUpdateAgoraxModeActivationInput {
  workspaceId: string;
  agentSessionId: string;
  status: AgentActivityAgoraxModeActivationStatus;
  source: AgentActivityAgoraxModeActivationSource;
  effect?: number | null;
  speed?: number | null;
  /**
   * Legacy single-axis alias of effect. Ignored when effect is present.
   *
   * @deprecated Use effect and speed.
   */
  orchestrationIntensity?: number | null;
  expectedRevision?: number | null;
  signal?: AbortSignal;
}

export interface AgentActivityUpdateAgoraxModeActivationResult {
  activation: AgentActivityAgoraxModeActivation;
  changed: boolean;
}
