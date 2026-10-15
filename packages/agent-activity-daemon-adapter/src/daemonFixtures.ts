import type {
  DaemonCanonicalInteraction,
  DaemonCanonicalMessage,
  DaemonCanonicalSession,
  DaemonCanonicalTurn,
  DaemonSessionActivityResponse
} from "./daemonDtos.ts";

/**
 * Test fixtures that reproduce the JSON the Agorax agent daemon actually
 * emits: Go encoding/json over the store-sqlite/host structs (PascalCase
 * field names, zero values emitted, nil maps as null). Key sets are asserted
 * in daemonDtos.test.ts so fixture drift fails loudly.
 */
export function createDaemonSession(
  overrides: Partial<DaemonCanonicalSession> = {}
): DaemonCanonicalSession {
  return {
    ID: "session-1",
    WorkspaceID: "workspace-1",
    Kind: "root",
    RootAgentSessionID: "",
    RootTurnID: "",
    ParentAgentSessionID: "",
    ParentTurnID: "",
    ParentToolCallID: "",
    Origin: "",
    UserID: "daemon-user-1",
    AgentTargetID: "local:codex",
    Provider: "codex",
    ProviderSessionID: "",
    Model: "",
    Settings: null,
    Capabilities: null,
    Metadata: { visible: true, imported: false },
    InternalRuntimeContext: null,
    Cwd: "/workspace",
    RailSectionKind: "",
    RailProjectPath: "",
    RailSectionKey: "conversations",
    Title: "Session",
    ActiveTurnID: "",
    MessageVersion: 7,
    LastEventUnixMS: 2,
    StartedAtUnixMS: 1,
    EndedAtUnixMS: 0,
    PinnedAtUnixMS: 0,
    CreatedAtUnixMS: 1,
    UpdatedAtUnixMS: 2,
    ...overrides
  };
}

export function createDaemonTurn(
  overrides: Partial<DaemonCanonicalTurn> = {}
): DaemonCanonicalTurn {
  return {
    WorkspaceID: "workspace-1",
    AgentSessionID: "session-1",
    TurnID: "turn-1",
    IdentityAnchorTurnID: "",
    CapabilityRefs: null,
    Phase: "settled",
    Outcome: "",
    ErrorMessage: "",
    ErrorCode: "",
    FileChanges: null,
    CompletedCommandKind: "",
    CompletedCommandStatus: "",
    FinalAssistantMessageID: "",
    FinalAssistantMessageResolved: false,
    Backfilled: false,
    StartedAtUnixMS: 1,
    SettledAtUnixMS: 0,
    CreatedAtUnixMS: 1,
    UpdatedAtUnixMS: 3,
    Origin: "user_prompt",
    SourceGoalOperationID: "",
    SourceGoalRevision: 0,
    SourceGoalRepairEpoch: 0,
    RootProviderTurnID: "",
    ProviderTurnBindingJSON: null,
    ProviderForkBindingAvailable: false,
    RootProviderTurnPhase: "",
    RootProviderTurnOutcome: "",
    RootProviderTurnErrorMessage: "",
    RootProviderTurnErrorCode: "",
    RootProviderTurnCompletedCommandKind: "",
    RootProviderTurnCompletedCommandStatus: "",
    RootProviderTurnUpdatedAtUnixMS: 0,
    ...overrides
  };
}

export function createDaemonMessage(
  overrides: Partial<DaemonCanonicalMessage> = {}
): DaemonCanonicalMessage {
  return {
    ID: 42,
    AgentSessionID: "session-1",
    MessageID: "message-1",
    Version: 7,
    TurnID: "turn-1",
    Role: "assistant",
    Kind: "text",
    Status: "",
    Semantics: null,
    Payload: { text: "hello" },
    OccurredAtUnixMS: 100,
    StartedAtUnixMS: 0,
    CompletedAtUnixMS: 0,
    CreatedAtUnixMS: 100,
    UpdatedAtUnixMS: 0,
    ...overrides
  };
}

export function createDaemonInteraction(
  overrides: Partial<DaemonCanonicalInteraction> = {}
): DaemonCanonicalInteraction {
  return {
    WorkspaceID: "workspace-1",
    AgentSessionID: "session-1",
    RequestID: "request-1",
    TurnID: "turn-1",
    Kind: "approval",
    Status: "pending",
    ToolName: "bash",
    Input: { command: "rm -rf /tmp/example" },
    Output: null,
    Metadata: null,
    CreatedAtUnixMS: 5,
    UpdatedAtUnixMS: 5,
    ...overrides
  };
}

export function createDaemonActivity(
  overrides: Partial<DaemonSessionActivityResponse> = {}
): DaemonSessionActivityResponse {
  return {
    workspaceId: "workspace-1",
    session: createDaemonSession(),
    turns: [createDaemonTurn()],
    messages: [createDaemonMessage()],
    interactions: [createDaemonInteraction()],
    ...overrides
  };
}
