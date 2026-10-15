import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { canonicalInteractionKey } from "./sessionEntityKeys.ts";
import { selectEngineInteractionResponse } from "./sessionLifecycle.selectors.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type { EngineExternalCommand, EngineScheduler } from "./types.ts";

function createHarness() {
  let nowUnixMs = 100;
  const commands: EngineExternalCommand[] = [];
  const rejecters = new Map<string, (error: unknown) => void>();
  const commandPort = createTestEngineCommandPort((command) => {
    commands.push(command);
    return new Promise((_resolve, reject) => {
      rejecters.set(command.commandId, reject);
    });
  });
  const scheduler: EngineScheduler = {
    schedule() {
      return { cancel() {} };
    }
  };
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => nowUnixMs },
    commandPort,
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler
  });
  engine.dispatch({
    sessions: [session()],
    type: "session/snapshotReceived"
  });
  return {
    commands,
    engine,
    fail(commandId: string) {
      rejecters.get(commandId)?.(new Error("temporary failure"));
      rejecters.delete(commandId);
    },
    setNow(value: number) {
      nowUnixMs = value;
    }
  };
}

test("semantic interaction response owns identity, scope, normalization, and timeout", () => {
  const harness = createHarness();

  const accepted = harness.engine.submitInteractionResponse({
    action: " approve ",
    agentSessionId: " session-1 ",
    optionId: " allow-once ",
    payload: { text: "because" },
    requestId: " request-1 ",
    turnId: " turn-1 "
  });

  assert.equal(accepted, true);
  assert.deepEqual(harness.commands, [
    {
      action: "approve",
      agentSessionId: "session-1",
      commandId: "interaction:100:1",
      correlationId: canonicalInteractionKey(
        "session-1",
        "turn-1",
        "request-1"
      ),
      optionId: "allow-once",
      payload: { text: "because" },
      requestId: "request-1",
      timeoutMs: 30_000,
      turnId: "turn-1",
      type: "interaction/respond",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    selectEngineInteractionResponse(
      harness.engine.getSnapshot(),
      "session-1",
      "turn-1",
      "request-1"
    )?.status,
    "responding"
  );
});

test("semantic interaction response deduplicates while one response is in flight", () => {
  const harness = createHarness();

  assert.equal(
    harness.engine.submitInteractionResponse(responseInput("allow-once")),
    true
  );
  assert.equal(
    harness.engine.submitInteractionResponse(responseInput("allow-once")),
    false
  );
  assert.equal(harness.commands.length, 1);
});

test("failed response retries only an explicitly submitted exact response", async () => {
  const harness = createHarness();

  assert.equal(
    harness.engine.submitInteractionResponse(responseInput("allow-once")),
    true
  );
  harness.fail("interaction:100:1");
  await flushMicrotasks();

  assert.equal(
    selectEngineInteractionResponse(
      harness.engine.getSnapshot(),
      "session-1",
      "turn-1",
      "request-1"
    )?.status,
    "failed"
  );

  harness.setNow(200);
  assert.equal(
    harness.engine.submitInteractionResponse({
      agentSessionId: "session-1",
      requestId: "request-1",
      turnId: "turn-1"
    }),
    false
  );
  assert.equal(
    harness.engine.submitInteractionResponse(responseInput("deny")),
    false
  );
  assert.equal(
    harness.engine.submitInteractionResponse(responseInput("allow-once")),
    true
  );
  assert.equal(harness.commands.length, 2);
  assert.equal(harness.commands[1]?.commandId, "interaction:200:4");
});

test("semantic interaction response fails closed without a canonical pending interaction", () => {
  const harness = createHarness();

  assert.equal(
    harness.engine.submitInteractionResponse({
      ...responseInput("allow-once"),
      requestId: "missing"
    }),
    false
  );
  assert.equal(harness.commands.length, 0);
});

function responseInput(optionId: string) {
  return {
    agentSessionId: "session-1",
    optionId,
    requestId: "request-1",
    turnId: "turn-1"
  };
}

function session() {
  const turn: AgentActivityTurn = {
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "waiting",
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  const pendingInteraction: AgentActivityInteraction = {
    agentSessionId: "session-1",
    createdAtUnixMs: 2,
    kind: "question",
    requestId: "request-1",
    status: "pending",
    turnId: "turn-1",
    updatedAtUnixMs: 2
  };
  return normalizeAgentActivitySession({
    activeTurn: turn,
    activeTurnId: turn.turnId,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurn: turn,
    latestTurnInteractions: [pendingInteraction],
    pendingInteractions: [pendingInteraction],
    provider: "codex",
    title: "Session",
    workspaceId: "workspace-1"
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
