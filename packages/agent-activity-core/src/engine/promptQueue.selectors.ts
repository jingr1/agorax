import { promptVisibleInQueueAdmission } from "./promptQueue.admission.ts";
import { deriveCanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";
import type {
  AgentSessionEngineState,
  AgentSessionEngineStateBase
} from "./types.ts";
import type {
  EngineQueuedPrompt,
  PromptQueueRecord
} from "./promptQueue.types.ts";

export function selectEnginePromptQueue(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): PromptQueueRecord | null {
  const id = agentSessionId?.trim() ?? "";
  return state.promptQueue.recordsBySessionId[id] ?? null;
}

/**
 * Mirrors the visible-queue admission decision in enqueueSubmit: true when an
 * ordinary auto submit would remain in the composer queue instead of draining
 * into an immediate send.
 */
export function selectEngineSubmitWouldBeVisibleInQueue(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  return promptVisibleInQueueAdmission(
    state.promptQueue.recordsBySessionId[id],
    deriveCanonicalSubmitAvailability(state.sessionLifecycle, id).state
  );
}

export function selectEngineQueuedPrompts(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): readonly EngineQueuedPrompt[] {
  return selectEnginePromptQueue(state, agentSessionId)?.prompts ?? [];
}

/**
 * Composer-facing queue depth. Matches Tutti AgentGUI: hide invisible
 * immediate-send entries, the in-flight head, and the send-next promotion so
 * an idle submit does not flash "1 message queued".
 */
export function selectEngineVisibleQueuedPrompts(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): readonly EngineQueuedPrompt[] {
  const record = selectEnginePromptQueue(state, agentSessionId);
  if (!record?.prompts.length) {
    return [];
  }
  const inFlightPromptId = record.inFlight?.promptId;
  const sendNextPromptId = record.sendNextPromptId;
  return record.prompts.filter(
    (prompt) =>
      prompt.visibleInQueue !== false &&
      prompt.id !== inFlightPromptId &&
      prompt.id !== sendNextPromptId
  );
}

export function selectEngineHasQueuedPrompts(
  state: AgentSessionEngineStateBase
): boolean {
  return Object.values(state.promptQueue.recordsBySessionId).some(
    (record) => record.prompts.length > 0
  );
}

export function selectEngineQueuedPrompt(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined,
  promptId: string | null | undefined
): EngineQueuedPrompt | null {
  const id = promptId?.trim() ?? "";
  return (
    selectEngineQueuedPrompts(state, agentSessionId).find(
      (prompt) => prompt.id === id
    ) ?? null
  );
}

export function selectEnginePromptQueueError(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined
): string | null {
  return selectEnginePromptQueue(state, agentSessionId)?.failureMessage ?? null;
}

export function selectEngineHasVisibleQueuedSubmit(
  state: AgentSessionEngineStateBase,
  agentSessionId: string | null | undefined,
  clientSubmitId: string | null | undefined
): boolean {
  const id = clientSubmitId?.trim() ?? "";
  return selectEngineQueuedPrompts(state, agentSessionId).some(
    (prompt) => prompt.clientSubmitId === id && prompt.visibleInQueue !== false
  );
}
