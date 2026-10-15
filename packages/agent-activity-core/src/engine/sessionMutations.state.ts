import type { EngineCommand, EngineReducerResult } from "./types.ts";
import type {
  SessionForkThroughTurnMutationRecord,
  SessionMutationRecord,
  SessionMutationsState
} from "./sessionMutations.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const MAX_SETTLED_SESSION_MUTATIONS = 128;

export function hasInFlightOverlap(
  state: SessionMutationsState,
  agentSessionIds: readonly string[]
): boolean {
  const ids = new Set(agentSessionIds);
  return Object.values(state.byMutationId).some(
    (record) =>
      record.status === "inFlight" &&
      record.agentSessionIds.some((id) => ids.has(id))
  );
}

export function invalidResult(
  state: SessionMutationsState,
  record: SessionMutationRecord
): EngineReducerResult<SessionMutationsState> {
  return replaceRecord(state, {
    ...record,
    errorCode: "invalid_command_result",
    errorMessage: null,
    status: "unknown"
  });
}

export function replaceRecord(
  state: SessionMutationsState,
  record: SessionMutationRecord
): EngineReducerResult<SessionMutationsState> {
  return { commands: NO_COMMANDS, state: withRecord(state, record) };
}

export function withRecord(
  state: SessionMutationsState,
  record: SessionMutationRecord
): SessionMutationsState {
  return boundedMutationState(
    { ...state.byMutationId, [record.mutationId]: record },
    record.mutationId
  );
}

export function withRequestedRecord(
  state: SessionMutationsState,
  record: SessionMutationRecord
): SessionMutationsState {
  const ids = new Set(record.agentSessionIds);
  return boundedMutationState(
    {
      ...Object.fromEntries(
        Object.entries(state.byMutationId).filter(
          ([, current]) =>
            current.status === "inFlight" ||
            isUnresolvedForkCoordination(current) ||
            !current.agentSessionIds.some((id) => ids.has(id))
        )
      ),
      [record.mutationId]: record
    },
    record.mutationId
  );
}

export function isUnresolvedForkCoordination(
  record: SessionMutationRecord
): record is SessionForkThroughTurnMutationRecord {
  return (
    record.kind === "forkThroughTurn" &&
    (record.status === "unknown" ||
      (record.ackStatus !== "idle" && record.ackStatus !== "acknowledged"))
  );
}

export function unchanged(
  state: SessionMutationsState
): EngineReducerResult<SessionMutationsState> {
  return { commands: NO_COMMANDS, state };
}

function boundedMutationState(
  records: Readonly<Record<string, SessionMutationRecord>>,
  currentMutationId: string
): SessionMutationsState {
  const entries = Object.entries(records);
  const settled = entries.filter(
    ([, record]) =>
      record.status !== "inFlight" && !isUnresolvedForkCoordination(record)
  );
  const retainedSettledIds = new Set(
    settled
      .filter(([mutationId]) => mutationId !== currentMutationId)
      .slice(-(MAX_SETTLED_SESSION_MUTATIONS - 1))
      .map(([mutationId]) => mutationId)
  );
  retainedSettledIds.add(currentMutationId);
  return {
    byMutationId: Object.fromEntries(
      entries.filter(
        ([mutationId, record]) =>
          record.status === "inFlight" ||
          isUnresolvedForkCoordination(record) ||
          retainedSettledIds.has(mutationId)
      )
    )
  };
}
