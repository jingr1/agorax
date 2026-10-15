import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonInteraction,
  createDaemonMessage,
  createDaemonSession,
  createDaemonTurn
} from "./daemonFixtures.ts";

// JSON key sets the Agorax agent daemon actually emits. Sources:
// - Session/Turn/Message/Interaction: store-sqlite/repository.go Go struct
//   fields (encoding/json default PascalCase; the two `json:"-"` Session
//   fields never marshal).
// - CapabilityReference: explicit lowercase json tags (repository.go).
// - SessionMetadata: explicit camelCase json tags (session_metadata.go).

const DAEMON_SESSION_KEYS = [
  "ID",
  "WorkspaceID",
  "Kind",
  "RootAgentSessionID",
  "RootTurnID",
  "ParentAgentSessionID",
  "ParentTurnID",
  "ParentToolCallID",
  "Origin",
  "UserID",
  "AgentTargetID",
  "Provider",
  "ProviderSessionID",
  "Model",
  "Settings",
  "Capabilities",
  "Metadata",
  "InternalRuntimeContext",
  "Cwd",
  "RailSectionKind",
  "RailProjectPath",
  "RailSectionKey",
  "Title",
  "ActiveTurnID",
  "MessageVersion",
  "LastEventUnixMS",
  "StartedAtUnixMS",
  "EndedAtUnixMS",
  "PinnedAtUnixMS",
  "CreatedAtUnixMS",
  "UpdatedAtUnixMS"
];

const DAEMON_TURN_KEYS = [
  "WorkspaceID",
  "AgentSessionID",
  "TurnID",
  "IdentityAnchorTurnID",
  "CapabilityRefs",
  "Phase",
  "Outcome",
  "ErrorMessage",
  "ErrorCode",
  "FileChanges",
  "CompletedCommandKind",
  "CompletedCommandStatus",
  "FinalAssistantMessageID",
  "FinalAssistantMessageResolved",
  "Backfilled",
  "StartedAtUnixMS",
  "SettledAtUnixMS",
  "CreatedAtUnixMS",
  "UpdatedAtUnixMS",
  "Origin",
  "SourceGoalOperationID",
  "SourceGoalRevision",
  "SourceGoalRepairEpoch",
  "RootProviderTurnID",
  "ProviderTurnBindingJSON",
  "ProviderForkBindingAvailable",
  "RootProviderTurnPhase",
  "RootProviderTurnOutcome",
  "RootProviderTurnErrorMessage",
  "RootProviderTurnErrorCode",
  "RootProviderTurnCompletedCommandKind",
  "RootProviderTurnCompletedCommandStatus",
  "RootProviderTurnUpdatedAtUnixMS"
];

const DAEMON_MESSAGE_KEYS = [
  "ID",
  "AgentSessionID",
  "MessageID",
  "Version",
  "TurnID",
  "Role",
  "Kind",
  "Status",
  "Semantics",
  "Payload",
  "OccurredAtUnixMS",
  "StartedAtUnixMS",
  "CompletedAtUnixMS",
  "CreatedAtUnixMS",
  "UpdatedAtUnixMS"
];

const DAEMON_INTERACTION_KEYS = [
  "WorkspaceID",
  "AgentSessionID",
  "RequestID",
  "TurnID",
  "Kind",
  "Status",
  "ToolName",
  "Input",
  "Output",
  "Metadata",
  "CreatedAtUnixMS",
  "UpdatedAtUnixMS"
];

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

test("daemon session DTO key set matches agorax-agentd storesqlite.Session JSON", () => {
  assert.deepEqual(sortedKeys(createDaemonSession()), DAEMON_SESSION_KEYS.sort());
});

test("daemon turn DTO key set matches agorax-agentd storesqlite.Turn JSON", () => {
  assert.deepEqual(sortedKeys(createDaemonTurn()), DAEMON_TURN_KEYS.sort());
});

test("daemon message DTO key set matches agorax-agentd storesqlite.Message JSON", () => {
  assert.deepEqual(
    sortedKeys(createDaemonMessage()),
    DAEMON_MESSAGE_KEYS.sort()
  );
});

test("daemon interaction DTO key set matches agorax-agentd storesqlite.Interaction JSON", () => {
  assert.deepEqual(
    sortedKeys(createDaemonInteraction()),
    DAEMON_INTERACTION_KEYS.sort()
  );
});

test("daemon capability reference items use the tagged lowercase field names", () => {
  const turn = createDaemonTurn({
    CapabilityRefs: [{ capability: "agorax", source: "slash_command" }]
  });
  assert.deepEqual(turn.CapabilityRefs, [
    { capability: "agorax", source: "slash_command" }
  ]);
});

test("daemon session metadata uses the tagged camelCase field names", () => {
  const session = createDaemonSession({
    Metadata: {
      visible: false,
      imported: true,
      usage: {
        contextWindow: { usedTokens: 10, totalTokens: 100 },
        quotas: [
          { quotaType: "rate", percentRemaining: 50, resetsAtUnixMs: null }
        ]
      },
      goal: { objective: "ship", status: "active" }
    }
  });
  assert.deepEqual(Object.keys(session.Metadata).sort(), [
    "goal",
    "imported",
    "usage",
    "visible"
  ]);
  assert.equal(session.Metadata.visible, false);
  assert.equal(session.Metadata.imported, true);
});

test("daemon message semantics use the tagged camelCase field names", () => {
  const message = createDaemonMessage({
    Semantics: {
      userVisibleAssistantResponse: true,
      turnSettling: true,
      noticeCommand: "compact",
      noticeCommandStatus: "completed"
    }
  });
  assert.deepEqual(Object.keys(message.Semantics!).sort(), [
    "noticeCommand",
    "noticeCommandStatus",
    "turnSettling",
    "userVisibleAssistantResponse"
  ]);
});
