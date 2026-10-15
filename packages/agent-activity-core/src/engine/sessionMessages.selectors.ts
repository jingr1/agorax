import type { AgentActivityMessage } from "../types.ts";
import type { AgentActivitySessionMessageWindow } from "../messageWindow.types.ts";
import type { AgentSessionEngineStateBase } from "./types.ts";

const EMPTY_MESSAGES: readonly AgentActivityMessage[] = [];

export function selectSessionMessagesById(
  state: AgentSessionEngineStateBase
): Readonly<Record<string, readonly AgentActivityMessage[]>> {
  return state.sessionMessages.messagesBySessionId;
}

export function selectSessionMessages(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): readonly AgentActivityMessage[] {
  const id = agentSessionId?.trim() ?? "";
  if (!id) return EMPTY_MESSAGES;
  return state.sessionMessages.messagesBySessionId[id] ?? EMPTY_MESSAGES;
}

export function selectSessionMessageWindow(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): Readonly<AgentActivitySessionMessageWindow> | null {
  const id = agentSessionId?.trim() ?? "";
  if (!id) return null;
  return state.sessionMessages.windowsBySessionId[id] ?? null;
}
