import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentActivityGoalControlText } from "./goalControl.ts";

test("parses the shared Goal command text surface", () => {
  assert.deepEqual(parseAgentActivityGoalControlText("/goal clear"), {
    action: "clear"
  });
  assert.deepEqual(parseAgentActivityGoalControlText("/goal\u3000pause"), {
    action: "pause"
  });
  assert.deepEqual(parseAgentActivityGoalControlText("/goal active"), {
    action: "resume"
  });
  assert.deepEqual(parseAgentActivityGoalControlText("/goal ship it"), {
    action: "set",
    objective: "ship it"
  });
});

test("does not manufacture a Goal command without an argument", () => {
  assert.equal(parseAgentActivityGoalControlText("/goal"), null);
  assert.equal(parseAgentActivityGoalControlText("ship it"), null);
});
