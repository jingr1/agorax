import assert from "node:assert/strict";
import test from "node:test";
import { daemonAgentSessionComposerSettingsFromActivity } from "./composerSettings.ts";

test("projects only settings supported by the composer contract", () => {
  assert.deepEqual(
    daemonAgentSessionComposerSettingsFromActivity({
      browserUse: false,
      computerUse: false,
      model: null,
      permissionModeId: "auto",
      planMode: true,
      reasoningEffort: "high",
      speed: "fast"
    }),
    {
      browserUse: false,
      model: null,
      permissionModeId: "auto",
      planMode: true,
      reasoningEffort: "high",
      speed: "fast"
    }
  );
});

test("does not invent a daemon request field for computer use", () => {
  assert.deepEqual(
    daemonAgentSessionComposerSettingsFromActivity({ computerUse: true }),
    {}
  );
});
