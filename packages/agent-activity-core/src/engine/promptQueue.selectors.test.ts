import assert from "node:assert/strict";
import test from "node:test";
import { createInitialAgentSessionEngineState } from "./rootReducer.ts";
import { promptQueueReducer } from "./promptQueue.reducer.ts";
import {
  selectEngineHasQueuedPrompts,
  selectEngineVisibleQueuedPrompts
} from "./promptQueue.selectors.ts";

test("workspace queued-prompt selector hides prompt queue storage shape", () => {
  const initial = createInitialAgentSessionEngineState();
  assert.equal(selectEngineHasQueuedPrompts(initial), false);

  const queued = promptQueueReducer(
    initial.promptQueue,
    {
      type: "queue/enqueued",
      agentSessionId: "session-1",
      workspaceId: "workspace-1",
      prompt: {
        id: "prompt-1",
        content: [{ type: "text", text: "Review" }],
        displayPrompt: "Review",
        createdAtUnixMs: 1
      }
    },
    { deletedSessionIds: {}, lifecycle: initial.sessionLifecycle }
  );
  assert.equal(
    selectEngineHasQueuedPrompts({ ...initial, promptQueue: queued.state }),
    true
  );
});

test("visible queued prompts hide immediate-send and in-flight heads", () => {
  const initial = createInitialAgentSessionEngineState();
  const withInvisible = promptQueueReducer(
    initial.promptQueue,
    {
      type: "queue/enqueued",
      agentSessionId: "session-1",
      workspaceId: "workspace-1",
      prompt: {
        id: "prompt-idle",
        content: [{ type: "text", text: "hi" }],
        createdAtUnixMs: 1,
        visibleInQueue: false
      }
    },
    { deletedSessionIds: {}, lifecycle: initial.sessionLifecycle }
  );
  assert.equal(
    selectEngineVisibleQueuedPrompts(
      { ...initial, promptQueue: withInvisible.state },
      "session-1"
    ).length,
    0
  );

  const withVisible = promptQueueReducer(
    withInvisible.state,
    {
      type: "queue/enqueued",
      agentSessionId: "session-1",
      workspaceId: "workspace-1",
      prompt: {
        id: "prompt-followup",
        content: [{ type: "text", text: "next" }],
        createdAtUnixMs: 2,
        visibleInQueue: true
      }
    },
    { deletedSessionIds: {}, lifecycle: initial.sessionLifecycle }
  );
  const record = withVisible.state.recordsBySessionId["session-1"];
  assert.ok(record);
  const withInFlight = {
    ...initial,
    promptQueue: {
      ...withVisible.state,
      recordsBySessionId: {
        "session-1": {
          ...record,
          inFlight: {
            commandId: "cmd-1",
            kind: "send" as const,
            promptId: "prompt-idle"
          }
        }
      }
    }
  };
  assert.deepEqual(
    selectEngineVisibleQueuedPrompts(withInFlight, "session-1").map(
      (prompt) => prompt.id
    ),
    ["prompt-followup"]
  );
});
