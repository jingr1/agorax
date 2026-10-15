import type { AgentActivityAgoraxModeActivation } from "../types.ts";
import type { AgentSessionEngineStateBase } from "./types.ts";

export interface AgoraxModeActivationPresentation {
  activation: AgentActivityAgoraxModeActivation | null;
  active: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  effect?: number;
  speed?: number;
  /** @deprecated Use effect and speed. */
  orchestrationIntensity: number;
  updateStatus: "idle" | "pending_create" | "updating" | "failed" | "uncertain";
}

export interface ResolvedAgoraxModeActivationPresentation extends AgoraxModeActivationPresentation {
  effect: number;
  speed: number;
}

const DEFAULT_PREFERENCE = 50;

export function selectAgoraxModeDraftIsActive(
  state: AgentSessionEngineStateBase,
  draftKey: string
): boolean {
  return (
    state.agoraxModeActivation.draftsByKey[draftKey.trim()]?.active === true
  );
}

export function selectAgoraxModeDraftPreferences(
  state: AgentSessionEngineStateBase,
  draftKey: string
): { effect: number | null; speed: number | null } {
  const draft = state.agoraxModeActivation.draftsByKey[draftKey.trim()];
  return {
    effect: draft?.effect ?? draft?.orchestrationIntensity ?? null,
    speed: draft?.speed ?? null
  };
}

/**
 * @deprecated Use selectAgoraxModeDraftPreferences.
 */
export function selectAgoraxModeDraftOrchestrationIntensity(
  state: AgentSessionEngineStateBase,
  draftKey: string
): number | null {
  return selectAgoraxModeDraftPreferences(state, draftKey).effect;
}

export function selectAgoraxModeActivationPresentation(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined,
  draftKey: string
): ResolvedAgoraxModeActivationPresentation {
  const sessionId = agentSessionId?.trim() ?? "";
  const draftPreferences = selectAgoraxModeDraftPreferences(state, draftKey);
  if (!sessionId) {
    return {
      activation: null,
      active: selectAgoraxModeDraftIsActive(state, draftKey),
      errorCode: null,
      errorMessage: null,
      effect: draftPreferences.effect ?? DEFAULT_PREFERENCE,
      speed: draftPreferences.speed ?? DEFAULT_PREFERENCE,
      orchestrationIntensity: draftPreferences.effect ?? DEFAULT_PREFERENCE,
      updateStatus: "idle"
    };
  }
  const update = state.agoraxModeActivation.updatesBySessionId[sessionId];
  const activation =
    state.agoraxModeActivation.activationsBySessionId[sessionId] ?? null;
  if (update) {
    return {
      activation,
      active:
        update.updateStatus === "failed"
          ? activation?.status === "active"
          : update.status === "active",
      errorCode: update.errorCode,
      errorMessage: update.errorMessage,
      effect:
        update.effect ??
        update.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      speed:
        update.speed ??
        activationSpeed(activation) ??
        draftPreferences.speed ??
        DEFAULT_PREFERENCE,
      orchestrationIntensity:
        update.effect ??
        update.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      updateStatus:
        update.updateStatus === "inFlight" ? "updating" : update.updateStatus
    };
  }
  const pending =
    state.agoraxModeActivation.pendingCreatesBySessionId[sessionId];
  if (pending) {
    return {
      activation,
      active: pending.initialActivation.status === "active",
      errorCode: null,
      errorMessage: null,
      effect:
        pending.initialActivation.effect ??
        pending.initialActivation.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      speed:
        pending.initialActivation.speed ??
        activationSpeed(activation) ??
        draftPreferences.speed ??
        DEFAULT_PREFERENCE,
      orchestrationIntensity:
        pending.initialActivation.effect ??
        pending.initialActivation.orchestrationIntensity ??
        activationEffect(activation) ??
        draftPreferences.effect ??
        DEFAULT_PREFERENCE,
      updateStatus: "pending_create"
    };
  }
  return {
    activation,
    active: activation?.status === "active",
    errorCode: null,
    errorMessage: null,
    effect:
      activationEffect(activation) ??
      draftPreferences.effect ??
      DEFAULT_PREFERENCE,
    speed:
      activationSpeed(activation) ??
      draftPreferences.speed ??
      DEFAULT_PREFERENCE,
    orchestrationIntensity:
      activationEffect(activation) ??
      draftPreferences.effect ??
      DEFAULT_PREFERENCE,
    updateStatus: "idle"
  };
}

function activationEffect(
  activation: AgentActivityAgoraxModeActivation | null
): number | null {
  return activation
    ? (activation.currentRevision.effect ??
        activation.currentRevision.orchestrationIntensity)
    : null;
}

function activationSpeed(
  activation: AgentActivityAgoraxModeActivation | null
): number | null {
  return activation
    ? (activation.currentRevision.speed ?? DEFAULT_PREFERENCE)
    : null;
}

export function agoraxModeActivationPresentationsEqual(
  left: AgoraxModeActivationPresentation,
  right: AgoraxModeActivationPresentation
): boolean {
  return (
    left.active === right.active &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage &&
    left.effect === right.effect &&
    left.speed === right.speed &&
    left.orchestrationIntensity === right.orchestrationIntensity &&
    left.updateStatus === right.updateStatus &&
    activationIdentity(left.activation) === activationIdentity(right.activation)
  );
}

function activationIdentity(
  activation: AgentActivityAgoraxModeActivation | null
): string {
  return activation
    ? `${activation.id}:${activation.currentRevision.revision}:${activation.status}`
    : "";
}
