import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonCanonicalSession } from "./daemonDtos.ts";
import {
  agentActivityInteractionFromDaemonInteraction,
  agentActivityMessageFromDaemonMessage,
  agentActivitySessionFromDaemonSession,
  agentActivityTurnFromDaemonTurn
} from "./index.ts";
import {
  createDaemonInteraction,
  createDaemonMessage,
  createDaemonSession,
  createDaemonTurn
} from "./daemonFixtures.ts";

test("session mapping preserves the daemon-owned user identity and model", () => {
  const session = agentActivitySessionFromDaemonSession(
    "workspace-1",
    createDaemonSession({ UserID: "daemon-user-1", Model: "gpt-5" }),
    { currentUserId: "fallback-user-1" }
  );
  assert.equal(session.userId, "daemon-user-1");
  assert.equal(session.model, "gpt-5");
  assert.equal(session.agentSessionId, "session-1");
  assert.equal(session.provider, "codex");
  assert.equal(session.messageVersion, 7);
  assert.equal(session.createdAtUnixMs, 1);
  assert.equal(session.updatedAtUnixMs, 2);
  assert.equal(session.lastEventUnixMs, 2);
});

test("session mapping falls back to the host-supplied user identity", () => {
  const session = agentActivitySessionFromDaemonSession(
    "workspace-1",
    createDaemonSession({ UserID: "" }),
    { currentUserId: "host-user-1" }
  );
  assert.equal(session.userId, "host-user-1");
});

test("session mapping fills daemon-only projections with daemon defaults", () => {
  const session = agentActivitySessionFromDaemonSession(
    "workspace-1",
    createDaemonSession(),
    { currentUserId: "host-user-1" }
  );
  assert.deepEqual(session.permissionConfig, { configurable: false, modes: [] });
  assert.deepEqual(session.lifecycleCapabilities, {
    fork: false,
    forkThroughTurn: false
  });
  assert.equal(session.capabilities, null);
  assert.equal(session.forkedFrom, null);
  assert.equal(session.goalSyncState, null);
  assert.equal(session.agoraxModeActivation, null);
  assert.equal(session.resumable, false);
  assert.equal(session.activeTurn, null);
  assert.equal(session.latestTurn, null);
  assert.deepEqual(session.latestTurnInteractions, []);
  assert.deepEqual(session.pendingInteractions, []);
  assert.equal(session.endedAtUnixMs, null);
  assert.equal(session.pinnedAtUnixMs, null);
});

test("session mapping projects metadata usage and goal", () => {
  const session = agentActivitySessionFromDaemonSession(
    "workspace-1",
    createDaemonSession({
      Metadata: {
        visible: false,
        imported: true,
        usage: {
          contextWindow: { usedTokens: 10, totalTokens: 100 },
          quotas: [
            { quotaType: "rate", percentRemaining: 50, resetsAtUnixMs: 123 }
          ]
        },
        goal: { objective: "ship it", status: "active", reason: "demo" }
      }
    }),
    { currentUserId: "host-user-1" }
  );
  assert.equal(session.visible, false);
  assert.equal(session.imported, true);
  assert.deepEqual(session.usage, {
    contextWindow: { usedTokens: 10, totalTokens: 100 },
    quotas: [{ quotaType: "rate", percentRemaining: 50, resetsAtUnixMs: 123 }]
  });
  assert.deepEqual(session.goal, {
    objective: "ship it",
    status: "active",
    reason: "demo"
  });
});

test("session mapping rejects malformed daemon contracts", () => {
  for (const field of [
    "ID",
    "Kind",
    "Provider",
    "ActiveTurnID",
    "MessageVersion",
    "Metadata",
    "RailSectionKey"
  ] as const) {
    const malformed = { ...createDaemonSession() } as Record<string, unknown>;
    delete malformed[field];
    assert.throws(
      () =>
        agentActivitySessionFromDaemonSession(
          "workspace-1",
          malformed as unknown as DaemonCanonicalSession,
          { currentUserId: "host-user-1" }
        ),
      new RegExp(`missing required field.*${field}`)
    );
  }
});

test("session mapping rejects an invalid message cursor", () => {
  assert.throws(
    () =>
      agentActivitySessionFromDaemonSession(
        "workspace-1",
        createDaemonSession({ MessageVersion: -1 }),
        { currentUserId: "host-user-1" }
      ),
    /MessageVersion must be a non-negative safe integer/
  );
});

test("session mapping rejects an invalid kind or goal status", () => {
  assert.throws(
    () =>
      agentActivitySessionFromDaemonSession(
        "workspace-1",
        createDaemonSession({ Kind: "wizard" }),
        { currentUserId: "host-user-1" }
      ),
    /kind "wizard" is invalid/
  );
  assert.throws(
    () =>
      agentActivitySessionFromDaemonSession(
        "workspace-1",
        createDaemonSession({
          Metadata: {
            visible: true,
            imported: false,
            goal: { objective: "x", status: "future" }
          }
        }),
        { currentUserId: "host-user-1" }
      ),
    /goal status "future" is invalid/
  );
});

test("turn mapping flattens daemon error and completed command fields", () => {
  const turn = agentActivityTurnFromDaemonTurn(
    createDaemonTurn({
      Phase: "settled",
      Outcome: "failed",
      ErrorMessage: "provider exploded",
      ErrorCode: "provider_error",
      CompletedCommandKind: "compact",
      CompletedCommandStatus: "completed",
      SettledAtUnixMS: 9,
      SourceGoalOperationID: "goal-operation-1",
      SourceGoalRevision: 3,
      SourceGoalRepairEpoch: 1
    })
  );
  assert.deepEqual(turn.error, {
    message: "provider exploded",
    code: "provider_error"
  });
  assert.deepEqual(turn.completedCommand, {
    kind: "compact",
    status: "completed"
  });
  assert.equal(turn.outcome, "failed");
  assert.equal(turn.origin, "user_prompt");
  assert.equal(turn.settledAtUnixMs, 9);
  assert.equal(turn.sourceGoalOperationId, "goal-operation-1");
  assert.equal(turn.sourceGoalRevision, 3);
  assert.equal(turn.sourceGoalRepairEpoch, 1);
});

test("turn mapping keeps empty daemon error and command fields null", () => {
  const turn = agentActivityTurnFromDaemonTurn(createDaemonTurn());
  assert.equal(turn.error, null);
  assert.equal(turn.completedCommand, null);
  assert.equal(turn.outcome, null);
  assert.equal("sourceGoalOperationId" in turn, false);
});

test("turn mapping coerces blank Origin to legacy_unknown", () => {
  const turn = agentActivityTurnFromDaemonTurn(
    createDaemonTurn({
      Phase: "settled",
      Outcome: "failed",
      ErrorMessage: "You’ve hit your usage limit.",
      Origin: ""
    })
  );
  assert.equal(turn.origin, "legacy_unknown");
  assert.equal(turn.phase, "settled");
  assert.equal(turn.outcome, "failed");
  assert.deepEqual(turn.error, { message: "You’ve hit your usage limit." });
});

test("turn mapping rejects invalid daemon phase or capability refs", () => {
  assert.throws(
    () =>
      agentActivityTurnFromDaemonTurn(
        createDaemonTurn({ Phase: "warping" })
      ),
    /phase "warping" is invalid/
  );
  assert.throws(
    () =>
      agentActivityTurnFromDaemonTurn(
        createDaemonTurn({
          CapabilityRefs: [{ capability: "agorax", source: "slash_command" }]
        })
      ),
    /unsupported workspace agent capability reference/
  );
});

test("turn mapping preserves durable agorax capability refs", () => {
  const turn = agentActivityTurnFromDaemonTurn(
    createDaemonTurn({
      CapabilityRefs: [{ capability: "agorax", source: "slash_command" }]
    })
  );
  assert.deepEqual(turn.capabilityRefs, [
    { capability: "agorax", source: "slash_command" }
  ]);
});

test("message mapping preserves durable sequence and normalizes timestamps", () => {
  const message = agentActivityMessageFromDaemonMessage(
    "workspace-1",
    createDaemonMessage({
      ID: 42,
      OccurredAtUnixMS: 0,
      CreatedAtUnixMS: 100,
      Version: 7
    })
  );
  assert.equal(message.sequence, 42);
  assert.equal(message.version, 7);
  assert.equal(message.occurredAtUnixMs, 100);
  assert.equal(message.createdAtUnixMs, 100);
});

test("message mapping trims turn ids and projects tagged semantics", () => {
  const sessionLevel = agentActivityMessageFromDaemonMessage(
    "workspace-1",
    createDaemonMessage({ TurnID: "  " })
  );
  assert.equal(sessionLevel.turnId, null);
  const turnOwned = agentActivityMessageFromDaemonMessage(
    "workspace-1",
    createDaemonMessage({
      TurnID: "  turn-1  ",
      Semantics: {
        userVisibleAssistantResponse: true,
        noticeCommand: "compact",
        noticeCommandStatus: "running"
      }
    })
  );
  assert.equal(turnOwned.turnId, "turn-1");
  assert.deepEqual(turnOwned.semantics, {
    userVisibleAssistantResponse: true,
    noticeCommand: "compact",
    noticeCommandStatus: "running"
  });
});

test("interaction mapping validates kind and status vocabularies", () => {
  const interaction = agentActivityInteractionFromDaemonInteraction(
    createDaemonInteraction()
  );
  assert.deepEqual(
    {
      agentSessionId: interaction.agentSessionId,
      requestId: interaction.requestId,
      turnId: interaction.turnId,
      kind: interaction.kind,
      status: interaction.status,
      toolName: interaction.toolName,
      input: interaction.input
    },
    {
      agentSessionId: "session-1",
      requestId: "request-1",
      turnId: "turn-1",
      kind: "approval",
      status: "pending",
      toolName: "bash",
      input: { command: "rm -rf /tmp/example" }
    }
  );
  assert.throws(
    () =>
      agentActivityInteractionFromDaemonInteraction(
        createDaemonInteraction({ Kind: "riddle" })
      ),
    /interaction kind "riddle" is invalid/
  );
  assert.throws(
    () =>
      agentActivityInteractionFromDaemonInteraction(
        createDaemonInteraction({ Status: "thinking" })
      ),
    /interaction status "thinking" is invalid/
  );
});
