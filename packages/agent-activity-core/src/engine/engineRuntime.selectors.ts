import type { AgentSessionEngineStateBase } from "./types.ts";

export function selectWorkspaceReconcileState(
  state: AgentSessionEngineStateBase
) {
  return state.engineRuntime.workspaceReconcile;
}
