import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivitySessionSettings } from "../types.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { selectEngineSessionSettingsUpdate } from "./sessionLifecycle.selectors.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type { EngineExternalCommand, EngineScheduler } from "./types.ts";

function createHarness() {
  let nowUnixMs = 100;
  let taskSequence = 0;
  const commands: EngineExternalCommand[] = [];
  const settlers = new Map<string, (value: unknown) => void>();
  const scheduled: Array<{
    atUnixMs: number;
    canceled: boolean;
    run(): void;
    sequence: number;
  }> = [];
  const commandPort = createTestEngineCommandPort((command) => {
    commands.push(command);
    return new Promise((resolve) => {
      settlers.set(command.commandId, resolve);
    });
  });
  const scheduler: EngineScheduler = {
    schedule(delayMs, run) {
      const task = {
        atUnixMs: nowUnixMs + delayMs,
        canceled: false,
        run,
        sequence: taskSequence++
      };
      scheduled.push(task);
      return {
        cancel() {
          task.canceled = true;
        }
      };
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
    advance(ms: number) {
      nowUnixMs += ms;
      for (;;) {
        const due = scheduled
          .filter((task) => !task.canceled && task.atUnixMs <= nowUnixMs)
          .sort(
            (left, right) =>
              left.atUnixMs - right.atUnixMs || left.sequence - right.sequence
          )[0];
        if (!due) return;
        due.canceled = true;
        due.run();
      }
    },
    commands,
    engine,
    succeed(commandId: string, settings: AgentActivitySessionSettings) {
      settlers.get(commandId)?.({
        agentSessionId: "session-1",
        session: session(settings)
      });
      settlers.delete(commandId);
    }
  };
}

test("semantic settings update owns command identity, scope, and timeout", async () => {
  const harness = createHarness();

  harness.engine.updateSessionSettings({
    agentSessionId: " session-1 ",
    settings: { planMode: true }
  });

  assert.deepEqual(harness.commands, [
    {
      agentSessionId: "session-1",
      commandId: "settings:100:1",
      correlationId: "session-1",
      settings: { planMode: true },
      timeoutMs: 30_000,
      type: "session/updateSettings",
      workspaceId: "workspace-1"
    }
  ]);

  harness.succeed("settings:100:1", { planMode: true });
  await flushMicrotasks();

  assert.equal(
    selectEngineSessionSettingsUpdate(harness.engine.getSnapshot(), "session-1")
      ?.status,
    "idle"
  );
});

test("semantic settings update treats a new user selection as the retry after unknown delivery", () => {
  const harness = createHarness();

  harness.engine.updateSessionSettings({
    agentSessionId: "session-1",
    settings: { planMode: true }
  });
  harness.advance(30_000);

  assert.equal(
    selectEngineSessionSettingsUpdate(harness.engine.getSnapshot(), "session-1")
      ?.status,
    "unknown"
  );

  harness.engine.updateSessionSettings({
    agentSessionId: "session-1",
    settings: { model: "model-2" }
  });

  assert.deepEqual(harness.commands[1], {
    agentSessionId: "session-1",
    commandId: "settings:30100:2",
    correlationId: "session-1",
    settings: { model: "model-2", planMode: true },
    timeoutMs: 30_000,
    type: "session/updateSettings",
    workspaceId: "workspace-1"
  });
});

function session(settings: AgentActivitySessionSettings = {}) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    settings,
    title: "Session",
    workspaceId: "workspace-1"
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
