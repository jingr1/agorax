import type {
  RootAgentSessionEngineState,
  RootEngineIntent
} from "./rootReducer.types.ts";
import { projectPublicSessionGoalControlState } from "./sessionGoalControl.selectors.ts";
import type { AgentSessionEngineState } from "./types.ts";

/**
 * Projects the host-observable Engine state. Keeping this as a real object
 * projection, rather than a type assertion, prevents private reducer ledgers
 * from leaking through getSnapshot() or subscription callbacks at runtime.
 */
export function projectPublicAgentSessionEngineState(
  state: RootAgentSessionEngineState,
  previous?: AgentSessionEngineState,
  previousRoot?: RootAgentSessionEngineState,
  cause?: RootEngineIntent
): AgentSessionEngineState {
  const goalControlUnchanged =
    previous !== undefined &&
    previousRoot !== undefined &&
    state.goalControl.operationsBySessionId ===
      previousRoot.goalControl.operationsBySessionId &&
    state.pendingIntents.activationsByRequestId ===
      previousRoot.pendingIntents.activationsByRequestId &&
    state.sessionLifecycle.sessionsById ===
      previousRoot.sessionLifecycle.sessionsById;
  const projected: AgentSessionEngineState = {
    attentionReadState: state.attentionReadState,
    composerOptions: state.composerOptions,
    editRetry: state.editRetry,
    engineRuntime: state.engineRuntime,
    goalControl: goalControlUnchanged
      ? previous.goalControl
      : projectPublicSessionGoalControlState(
          state,
          previous?.goalControl,
          previousRoot,
          cause
        ),
    pendingIntents: state.pendingIntents,
    planDecisions: state.planDecisions,
    promptQueue: state.promptQueue,
    sessionCommands: state.sessionCommands,
    sessionLifecycle: state.sessionLifecycle,
    sessionMessages: state.sessionMessages,
    sessionMutations: state.sessionMutations,
    sessionReconcile: state.sessionReconcile,
    agoraxModeActivation: state.agoraxModeActivation
  };
  if (
    previous &&
    Object.keys(projected).every(
      (key) =>
        previous[key as keyof AgentSessionEngineState] ===
        projected[key as keyof AgentSessionEngineState]
    )
  ) {
    return previous;
  }
  return projected;
}
