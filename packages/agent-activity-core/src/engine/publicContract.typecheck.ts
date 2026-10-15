import type {
  AgentActivityDeleteSessionsResult,
  AgentActivitySession,
  AgentSessionEffectPort,
  AgentSessionEngine,
  AgentSessionEngineState,
  EngineExtensionCommand,
  EngineIntent
} from "../index.ts";

type Assert<T extends true> = T;
type IsEqual<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

export type PromptExecutionIntentRemainsPrivate = Assert<
  IsNever<Extract<EngineIntent, { type: "prompt/executionRequested" }>>
>;

export type PromptExecutionStateRemainsPrivate = Assert<
  "promptExecutions" extends keyof AgentSessionEngineState ? false : true
>;

export type GoalControlOperationLedgerRemainsPrivate = Assert<
  "operationsBySessionId" extends keyof AgentSessionEngineState["goalControl"]
    ? false
    : true
>;

export type RenameRemainsTypedEffect = Assert<
  IsNever<Extract<EngineExtensionCommand, { type: "session/rename" }>>
>;

type SessionMutationOperation =
  | "deleteSessions"
  | "renameSession"
  | "setSessionPinned";

export type SessionMutationsUseSemanticEngineOperations = Assert<
  SessionMutationOperation extends keyof AgentSessionEngine ? true : false
>;

export type DeleteSessionsEffectReturnsTypedResult = Assert<
  IsEqual<
    Awaited<ReturnType<AgentSessionEffectPort["deleteSessions"]>>,
    AgentActivityDeleteSessionsResult
  >
>;

export type RenameSessionEffectReturnsTypedResult = Assert<
  IsEqual<
    Awaited<ReturnType<AgentSessionEffectPort["renameSession"]>>,
    { session: AgentActivitySession }
  >
>;

export type SetSessionPinnedEffectReturnsTypedResult = Assert<
  IsEqual<
    Awaited<ReturnType<AgentSessionEffectPort["setSessionPinned"]>>,
    { session: AgentActivitySession }
  >
>;
