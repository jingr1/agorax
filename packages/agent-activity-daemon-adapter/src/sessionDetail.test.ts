import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonSessionActivityResponse } from "./daemonDtos.ts";
import { agentActivitySessionDetailFromDaemon } from "./index.ts";
import {
  createDaemonActivity,
  createDaemonInteraction,
  createDaemonMessage,
  createDaemonSession,
  createDaemonTurn
} from "./daemonFixtures.ts";

test("detail mapping preserves the authoritative daemon aggregate", () => {
  const detail = agentActivitySessionDetailFromDaemon(
    "workspace-1",
    "session-1",
    createDaemonActivity({
      session: createDaemonSession({
        ActiveTurnID: "turn-2",
        Metadata: {
          visible: true,
          imported: false,
          usage: {
            contextWindow: { usedTokens: 1, totalTokens: 2 },
            quotas: []
          }
        }
      }),
      turns: [
        createDaemonTurn({ TurnID: "turn-1", UpdatedAtUnixMS: 3 }),
        createDaemonTurn({
          TurnID: "turn-2",
          Phase: "running",
          UpdatedAtUnixMS: 8,
          CapabilityRefs: [{ capability: "agorax", source: "slash_command" }]
        })
      ],
      messages: [
        createDaemonMessage({ MessageID: "message-1", ID: 1 }),
        createDaemonMessage({
          MessageID: "message-2",
          ID: 2,
          TurnID: "turn-2"
        })
      ],
      interactions: [
        createDaemonInteraction({
          RequestID: "request-1",
          TurnID: "turn-2",
          Kind: "question",
          Status: "pending"
        }),
        createDaemonInteraction({
          RequestID: "request-2",
          TurnID: "turn-1",
          Status: "answered"
        })
      ]
    }),
    { currentUserId: "host-user-1" }
  );

  assert.equal(detail.projection, "authoritative");
  assert.equal(detail.lifecycleCapabilitiesProjected, false);
  assert.equal(detail.workspaceId, "workspace-1");
  assert.equal(detail.session.agentSessionId, "session-1");
  assert.equal(detail.session.userId, "daemon-user-1");
  assert.equal(detail.session.activeTurn?.turnId, "turn-2");
  assert.equal(detail.session.latestTurn?.turnId, "turn-2");
  assert.deepEqual(
    detail.session.latestTurnInteractions.map(
      (interaction) => interaction.requestId
    ),
    ["request-1"]
  );
  assert.deepEqual(
    detail.session.pendingInteractions.map(
      (interaction) => interaction.requestId
    ),
    ["request-1"]
  );
  assert.deepEqual(
    detail.turns.map((turn) => [turn.turnId, turn.phase]),
    [
      ["turn-1", "settled"],
      ["turn-2", "running"]
    ]
  );
  assert.deepEqual(detail.turns[1]?.capabilityRefs, [
    { capability: "agorax", source: "slash_command" }
  ]);
  assert.deepEqual(
    detail.messages.map((message) => [message.messageId, message.sequence]),
    [
      ["message-1", 1],
      ["message-2", 2]
    ]
  );
  assert.deepEqual(
    detail.interactions.map((interaction) => interaction.requestId),
    ["request-1", "request-2"]
  );
  assert.deepEqual(detail.childSessions, []);
});

test("detail mapping resolves the latest turn by newest update time", () => {
  const detail = agentActivitySessionDetailFromDaemon(
    "workspace-1",
    "session-1",
    createDaemonActivity({
      turns: [
        createDaemonTurn({ TurnID: "turn-new", UpdatedAtUnixMS: 30 }),
        createDaemonTurn({ TurnID: "turn-old", UpdatedAtUnixMS: 10 })
      ]
    }),
    { currentUserId: "host-user-1" }
  );
  assert.equal(detail.session.latestTurn?.turnId, "turn-new");
  assert.equal(detail.session.activeTurn, null);
});

test("detail mapping rejects a response for a different requested Session", () => {
  assert.throws(
    () =>
      agentActivitySessionDetailFromDaemon(
        "workspace-1",
        "requested-1",
        createDaemonActivity({
          session: createDaemonSession({ ID: "other-1" })
        }),
        { currentUserId: "host-user-1" }
      ),
    /root Session id.*does not match requested id/
  );
});

test("detail mapping rejects Turns, Messages, or Interactions owned by another Session", () => {
  const foreignTurn = {
    ...createDaemonActivity({
      turns: [createDaemonTurn({ AgentSessionID: "foreign-session" })]
    })
  } satisfies DaemonSessionActivityResponse;
  assert.throws(
    () =>
      agentActivitySessionDetailFromDaemon(
        "workspace-1",
        "session-1",
        foreignTurn,
        { currentUserId: "host-user-1" }
      ),
    /Turn.*must be owned by requested Session/
  );

  const foreignMessage = createDaemonActivity({
    messages: [createDaemonMessage({ AgentSessionID: "foreign-session" })]
  });
  assert.throws(
    () =>
      agentActivitySessionDetailFromDaemon(
        "workspace-1",
        "session-1",
        foreignMessage,
        { currentUserId: "host-user-1" }
      ),
    /Message.*must be owned by requested Session/
  );

  const foreignInteraction = createDaemonActivity({
    interactions: [
      createDaemonInteraction({ AgentSessionID: "foreign-session" })
    ]
  });
  assert.throws(
    () =>
      agentActivitySessionDetailFromDaemon(
        "workspace-1",
        "session-1",
        foreignInteraction,
        { currentUserId: "host-user-1" }
      ),
    /Interaction.*must be owned by requested Session/
  );
});

test("detail mapping fails atomically when a nested entity violates the contract", () => {
  assert.throws(
    () =>
      agentActivitySessionDetailFromDaemon(
        "workspace-1",
        "session-1",
        createDaemonActivity({
          turns: [createDaemonTurn({ Phase: "warping" })]
        }),
        { currentUserId: "host-user-1" }
      ),
    /phase "warping" is invalid/
  );
});
