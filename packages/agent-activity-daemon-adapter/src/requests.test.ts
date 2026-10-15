import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentPromptContentBlock,
  AgentSessionActivateEffectInput
} from "@agorax/agent-activity-core";
import {
  daemonCreateAgentSessionRequestFromActivation,
  daemonCreateAgentSessionRequestFromActivity,
  daemonSendAgentSessionInputRequestFromActivity
} from "./index.ts";

test("create and send projections share one prompt allowlist", () => {
  const content = [activityTextBlock()];
  const activityCreate = daemonCreateAgentSessionRequestFromActivity({
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    cwd: "/workspace",
    initialContent: content,
    model: "gpt-5",
    workspaceId: "workspace-1"
  });
  const activationCreate = daemonCreateAgentSessionRequestFromActivation({
    activationId: "activation-1",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    initialContent: content,
    isolation: "worktree",
    mode: "new",
    settings: {
      browserUse: true,
      codexSaverMode: true,
      computerUse: true,
      model: "gpt-5",
      permissionModeId: "auto",
      planMode: true,
      reasoningEffort: "high",
      rtkSaverMode: true,
      speed: "fast"
    },
    workspaceId: "workspace-1"
  } satisfies AgentSessionActivateEffectInput);
  const send = daemonSendAgentSessionInputRequestFromActivity({
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content,
    workspaceId: "workspace-1"
  });

  for (const projected of [
    activityCreate.initialContent,
    activationCreate.initialContent,
    send.content
  ]) {
    assert.deepEqual(projected, [{ text: "hello", type: "text" }]);
  }
  assert.equal(activityCreate.cwd, "/workspace");
  assert.equal(activityCreate.model, "gpt-5");
  assert.equal(activationCreate.model, "gpt-5");
  assert.equal("browserUse" in activationCreate, false);
  assert.equal("computerUse" in activationCreate, false);
  assert.equal("permissionModeId" in activationCreate, false);
});

test("create projection targets only fields the daemon decodes", () => {
  const request = daemonCreateAgentSessionRequestFromActivity({
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    capabilityRefs: [{ capability: "agorax", source: "slash_command" }],
    initialContent: [{ text: "hello", type: "text" }],
    initialDisplayPrompt: "hello",
    planMode: true,
    submitDiagnostics: { source: "test" },
    title: "Local title",
    visible: false,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(request, {
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-1",
    initialContent: [{ text: "hello", type: "text" }],
    displayPrompt: "hello"
  });
});

test("request projection rejects local file blocks", () => {
  assert.throws(
    () =>
      daemonSendAgentSessionInputRequestFromActivity({
        agentSessionId: "session-1",
        clientSubmitId: "submit-1",
        content: [{ hostPath: "/tmp/file.txt", type: "file" }],
        workspaceId: "workspace-1"
      }),
    /File prompt blocks must be uploaded before submission/
  );
});

test("request projection rejects unsupported image MIME types", () => {
  assert.throws(
    () =>
      daemonSendAgentSessionInputRequestFromActivity({
        agentSessionId: "session-1",
        clientSubmitId: "submit-1",
        content: [{ data: "...", mimeType: "image/gif", type: "image" }],
        workspaceId: "workspace-1"
      }),
    /Unsupported workspace agent prompt image MIME type/
  );
});

test("send projection keeps displayPrompt and drops unsupported fields", () => {
  const projected = daemonSendAgentSessionInputRequestFromActivity({
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "agorax", source: "slash_command" }],
    clientSubmitId: "submit-connector",
    content: [
      { text: "list my calendar events", type: "text" },
      { connectorKey: "lark-cli", type: "connector" }
    ],
    displayPrompt: "/lark-cli list my calendar events",
    guidance: true,
    targetTurnId: "turn-target",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(projected, {
    clientSubmitId: "submit-connector",
    content: [
      { text: "list my calendar events", type: "text" },
      { connectorKey: "lark-cli", type: "connector" }
    ],
    displayPrompt: "/lark-cli list my calendar events"
  });
});

function activityTextBlock(): AgentPromptContentBlock {
  return {
    assetId: "asset-1",
    hostPath: "/tmp/local-only.txt",
    kind: "local-text",
    sizeBytes: 5,
    text: "hello",
    type: "text",
    uploadStatus: "uploaded",
    uri: "file:///tmp/local-only.txt"
  };
}
