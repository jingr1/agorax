import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentActivitySession } from "../sessionNormalization.ts";
import type { AgentActivitySession } from "../types.ts";
import {
  createInitialAgoraxModeActivationState,
  agoraxModeActivationReducer
} from "./agoraxModeActivation.reducer.ts";
import {
  selectAgoraxModeActivationPresentation,
  selectAgoraxModeDraftIsActive,
  selectAgoraxModeDraftOrchestrationIntensity
} from "./agoraxModeActivation.selectors.ts";

test("legacy activation revisions normalize at the engine boundary", () => {
  const legacySession = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 10,
        orchestrationIntensity: 73,
        revision: 3,
        source: "slash_command",
        status: "active"
      }
    })
  );
  const state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: legacySession, type: "session/upserted" },
    { "session-1": legacySession }
  ).state;
  const presentation = selectAgoraxModeActivationPresentation(
    engineState(state),
    "session-1",
    "node-1:home"
  );

  assert.equal(presentation.effect, 73);
  assert.equal(presentation.speed, 50);
  assert.equal(presentation.orchestrationIntensity, 73);
});

test("home Agorax intent transfers to an optimistic session and clears only after canonical hydration", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "agoraxMode/draftSet"
  }).state;

  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialAgoraxModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    agoraxModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;

  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );
  assert.equal(
    selectAgoraxModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );

  const earlyNull = session(null);
  state = reduce(
    state,
    { sessions: [earlyNull], type: "session/snapshotReceived" },
    { "session-1": earlyNull }
  ).state;
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.draftKey,
    "node-1:home"
  );
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );

  const staleInactive = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 15,
        effect: 50,
        orchestrationIntensity: 50,
        speed: 50,
        revision: 1,
        source: "badge_remove",
        status: "inactive"
      },
      status: "inactive",
      updatedAtUnixMs: 15
    })
  );
  state = reduce(
    state,
    { session: staleInactive, type: "session/upserted" },
    { "session-1": staleInactive }
  ).state;
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.draftKey,
    "node-1:home"
  );
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );

  const canonical = session(activeActivation());
  state = reduce(
    state,
    { sessions: [canonical], type: "session/snapshotReceived" },
    { "session-1": canonical }
  ).state;

  assert.equal(
    selectAgoraxModeDraftIsActive(engineState(state), "node-1:home"),
    false
  );
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );
});

test("successful create result with the authoritative activation settles without waiting for an event", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "agoraxMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialAgoraxModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    agoraxModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;
  const canonical = session(activeActivation());
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: { session: canonical }
  }).state;

  assert.equal(state.pendingCreatesBySessionId["session-1"], undefined);
  assert.equal(
    selectAgoraxModeDraftIsActive(engineState(state), "node-1:home"),
    false
  );
  assert.equal(state.activationsBySessionId["session-1"]?.status, "active");
});

test("failed new-session activation preserves the home Agorax intent for retry", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "agoraxMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialAgoraxModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    agoraxModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;
  state = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    errorMessage: "create failed",
    outcome: "failed",
    type: "engine/commandResult"
  }).state;

  assert.equal(
    selectAgoraxModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );
  assert.equal(state.pendingCreatesBySessionId["session-1"], undefined);
});

test("timed out new-session activation stays pending until canonical proof or expiry", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    type: "agoraxMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialAgoraxModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    agoraxModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;

  const timedOut = reduce(state, {
    commandId: "activate:activation-1",
    commandType: "session/activate",
    correlationId: "activation-1",
    outcome: "timedOut",
    type: "engine/commandResult"
  });
  state = timedOut.state;

  assert.deepEqual(timedOut.commands, [
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-create-reconcile:activation-1",
      live: false,
      scope: "state",
      timeoutMs: 15_000,
      type: "session/reconcile",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.reconcileCommandId,
    "agorax-mode-create-reconcile:activation-1"
  );
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );

  const inactive = session(null);
  state = reduce(
    state,
    { session: inactive, type: "session/upserted" },
    { "session-1": inactive }
  ).state;
  assert.notEqual(state.pendingCreatesBySessionId["session-1"], undefined);

  state = reduce(
    state,
    {
      commandId: "agorax-mode-create-reconcile:activation-1",
      commandType: "session/reconcile",
      errorMessage: "network unavailable",
      outcome: "failed",
      type: "engine/commandResult"
    },
    { "session-1": inactive }
  ).state;
  assert.notEqual(state.pendingCreatesBySessionId["session-1"], undefined);
  assert.equal(
    selectAgoraxModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );

  state = reduce(state, {
    dueAtUnixMs: 1_000,
    expiryId: "activation:activation-1",
    type: "engine/intentExpired"
  }).state;
  assert.equal(state.pendingCreatesBySessionId["session-1"], undefined);
  assert.equal(
    selectAgoraxModeDraftIsActive(engineState(state), "node-1:home"),
    true
  );
});

test("existing-session toggle uses the canonical revision and reconciles from the returned activation", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;

  const requested = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "agoraxMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  );
  state = requested.state;

  assert.deepEqual(requested.commands, [
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      expectedRevision: 3,
      source: "badge_remove",
      status: "inactive",
      timeoutMs: 15_000,
      type: "agoraxMode/update",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );

  const inactive = activeActivation({
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 110,
      effect: 50,
      orchestrationIntensity: 50,
      speed: 50,
      revision: 4,
      source: "badge_remove",
      status: "inactive"
    },
    status: "inactive",
    updatedAtUnixMs: 110
  });
  state = reduce(
    state,
    {
      commandId: "agorax-mode-1",
      commandType: "agoraxMode/update",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: { activation: inactive, changed: true }
    },
    { "session-1": canonical }
  ).state;

  const presentation = selectAgoraxModeActivationPresentation(
    engineState(state),
    "session-1",
    "node-1:home"
  );
  assert.equal(presentation.active, false);
  assert.equal(presentation.updateStatus, "idle");
  assert.equal(presentation.activation?.currentRevision.revision, 4);
});

test("turn capability references never hydrate current Agorax state", () => {
  const canonical = session(null);
  const state = reduce(
    createInitialAgoraxModeActivationState(),
    {
      turn: {
        agentSessionId: "session-1",
        capabilityRefs: [
          { capability: "agorax", source: "slash_command" as const }
        ],
        outcome: null,
        origin: "user_prompt",
        phase: "running",
        settledAtUnixMs: null,
        startedAtUnixMs: 1,
        turnId: "turn-1",
        updatedAtUnixMs: 1
      },
      live: true,
      type: "turn/upserted"
    },
    { "session-1": canonical }
  ).state;

  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );
});

test("canonical null and inactive projections remain inactive after reload", () => {
  const neverConfigured = session(null);
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { sessions: [neverConfigured], type: "session/snapshotReceived" },
    { "session-1": neverConfigured }
  ).state;
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );

  const inactive = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 20,
        effect: 50,
        orchestrationIntensity: 50,
        speed: 50,
        revision: 4,
        source: "badge_remove",
        status: "inactive"
      },
      status: "inactive",
      updatedAtUnixMs: 20
    })
  );
  state = reduce(
    state,
    { sessions: [inactive], type: "session/snapshotReceived" },
    { "session-1": inactive }
  ).state;
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    false
  );
  assert.equal(
    state.activationsBySessionId["session-1"]?.currentRevision.revision,
    4
  );
});

test("revision conflicts and timeouts request state reconciliation", () => {
  const canonical = session(activeActivation());
  for (const result of [
    {
      errorCode: "revision_conflict",
      errorMessage: "stale revision",
      outcome: "failed" as const
    },
    {
      errorMessage: "timed out",
      outcome: "timedOut" as const
    }
  ]) {
    let state = reduce(
      createInitialAgoraxModeActivationState(),
      { session: canonical, type: "session/upserted" },
      { "session-1": canonical }
    ).state;
    const requested = reduce(
      state,
      {
        agentSessionId: "session-1",
        commandId: "agorax-mode-1",
        requestedAtUnixMs: 100,
        source: "badge_remove",
        status: "inactive",
        type: "agoraxMode/updateRequested",
        workspaceId: "workspace-1"
      },
      { "session-1": canonical }
    );
    state = requested.state;
    const settled = reduce(
      state,
      {
        commandId: "agorax-mode-1",
        commandType: "agoraxMode/update",
        type: "engine/commandResult",
        ...result
      },
      { "session-1": canonical }
    );
    assert.deepEqual(settled.commands, [
      {
        agentSessionId: "session-1",
        commandId: "agorax-mode-reconcile:agorax-mode-1",
        live: false,
        scope: "state",
        timeoutMs: 15_000,
        type: "session/reconcile",
        workspaceId: "workspace-1"
      }
    ]);
    assert.equal(
      settled.state.updatesBySessionId["session-1"]?.updateStatus,
      "uncertain"
    );
  }
});

test("an arbitrary hydration cannot settle an uncertain update", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "agoraxMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "agorax-mode-1",
      commandType: "agoraxMode/update",
      errorMessage: "timed out",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  const reconciled = reduce(
    state,
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;

  assert.equal(
    reconciled.updatesBySessionId["session-1"]?.updateStatus,
    "uncertain"
  );
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(reconciled),
      "session-1",
      "node-1:home"
    ).active,
    false
  );
});

test("semantic revision evidence settles an uncertain update", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "agoraxMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "agorax-mode-1",
      commandType: "agoraxMode/update",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;
  const inactive = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 110,
        effect: 50,
        orchestrationIntensity: 50,
        speed: 50,
        revision: 4,
        source: "badge_remove",
        status: "inactive"
      },
      status: "inactive",
      updatedAtUnixMs: 110
    })
  );

  state = reduce(
    state,
    { session: inactive, type: "session/upserted" },
    { "session-1": inactive }
  ).state;

  assert.equal(state.updatesBySessionId["session-1"], undefined);
  assert.equal(state.activationsBySessionId["session-1"]?.status, "inactive");
});

test("the owned reconcile result makes an unresolved update retryable", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      requestedAtUnixMs: 100,
      source: "badge_remove",
      status: "inactive",
      type: "agoraxMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "agorax-mode-1",
      commandType: "agoraxMode/update",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  state = reduce(
    state,
    {
      commandId: "agorax-mode-reconcile:agorax-mode-1",
      commandType: "session/reconcile",
      outcome: "succeeded",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  const update = state.updatesBySessionId["session-1"];
  assert.equal(update?.updateStatus, "failed");
  assert.equal(update?.errorCode, "agorax_mode_update_not_applied");
  assert.equal(
    selectAgoraxModeActivationPresentation(
      engineState(state),
      "session-1",
      "node-1:home"
    ).active,
    true
  );
});

test("draftSet stores validated effect and speed preferences independently", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    effect: 70,
    speed: 40,
    type: "agoraxMode/draftSet"
  }).state;
  assert.equal(state.draftsByKey["node-1:home"]?.effect, 70);
  assert.equal(state.draftsByKey["node-1:home"]?.speed, 40);

  // Same values preserve referential equality.
  const unchangedResult = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 20,
    effect: 70,
    speed: 40,
    type: "agoraxMode/draftSet"
  });
  assert.equal(unchangedResult.state, state);

  // Omitting one preference preserves its current value.
  const preserved = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 25,
    effect: 20,
    type: "agoraxMode/draftSet"
  }).state;
  assert.equal(preserved.draftsByKey["node-1:home"]?.effect, 20);
  assert.equal(preserved.draftsByKey["node-1:home"]?.speed, 40);

  // Out-of-range values normalize to the daemon default sentinel.
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 40,
    speed: 250,
    type: "agoraxMode/draftSet"
  }).state;
  assert.equal(state.draftsByKey["node-1:home"]?.speed, null);
});

test("legacy orchestration intensity remains an effect alias", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    orchestrationIntensity: 73,
    type: "agoraxMode/draftSet"
  }).state;

  assert.equal(state.draftsByKey["node-1:home"]?.effect, 73);
  assert.equal(state.draftsByKey["node-1:home"]?.speed, null);
  assert.equal(state.draftsByKey["node-1:home"]?.orchestrationIntensity, 73);
  assert.equal(
    selectAgoraxModeDraftOrchestrationIntensity(
      engineState(state),
      "node-1:home"
    ),
    73
  );
});

test("pending create copies both draft preferences when the intent lacks them", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    effect: 80,
    speed: 65,
    type: "agoraxMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialAgoraxModeActivation: {
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    agoraxModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;

  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.initialActivation.effect,
    80
  );
  assert.equal(
    state.pendingCreatesBySessionId["session-1"]?.initialActivation.speed,
    65
  );
  const presentation = selectAgoraxModeActivationPresentation(
    engineState(state),
    "session-1",
    "node-1:home"
  );
  assert.equal(presentation.effect, 80);
  assert.equal(presentation.speed, 65);
});

test("pending create prefers intent-carried preferences over the draft", () => {
  let state = createInitialAgoraxModeActivationState();
  state = reduce(state, {
    active: true,
    draftKey: "node-1:home",
    occurredAtUnixMs: 10,
    effect: 80,
    speed: 65,
    type: "agoraxMode/draftSet"
  }).state;
  state = reduce(state, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "submit-1",
    expiresAtUnixMs: 1_000,
    initialAgoraxModeActivation: {
      effect: 30,
      speed: 90,
      source: "slash_command",
      status: "active"
    },
    mode: "new",
    requestedAtUnixMs: 20,
    requestId: "activation-1",
    agoraxModeDraftKey: "node-1:home",
    type: "activation/requested",
    workspaceId: "workspace-1"
  }).state;

  assert.deepEqual(
    {
      effect:
        state.pendingCreatesBySessionId["session-1"]?.initialActivation.effect,
      speed:
        state.pendingCreatesBySessionId["session-1"]?.initialActivation.speed
    },
    { effect: 30, speed: 90 }
  );
});

test("same-status preference update proceeds and settles on a matching revision", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;

  const requested = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      effect: 90,
      speed: 80,
      requestedAtUnixMs: 100,
      source: "slash_command",
      status: "active",
      type: "agoraxMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  );
  state = requested.state;

  assert.deepEqual(requested.commands, [
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      effect: 90,
      expectedRevision: 3,
      orchestrationIntensity: 90,
      source: "slash_command",
      speed: 80,
      status: "active",
      timeoutMs: 15_000,
      type: "agoraxMode/update",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(state.updatesBySessionId["session-1"]?.effect, 90);
  assert.equal(state.updatesBySessionId["session-1"]?.speed, 80);

  const applied = activeActivation({
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 110,
      effect: 90,
      orchestrationIntensity: 90,
      speed: 80,
      revision: 4,
      source: "slash_command",
      status: "active"
    },
    updatedAtUnixMs: 110
  });
  state = reduce(
    state,
    {
      commandId: "agorax-mode-1",
      commandType: "agoraxMode/update",
      outcome: "succeeded",
      type: "engine/commandResult",
      value: { activation: applied, changed: true }
    },
    { "session-1": canonical }
  ).state;
  assert.equal(state.updatesBySessionId["session-1"], undefined);
  assert.deepEqual(
    {
      effect: state.activationsBySessionId["session-1"]?.currentRevision.effect,
      speed: state.activationsBySessionId["session-1"]?.currentRevision.speed
    },
    { effect: 90, speed: 80 }
  );
});

test("same-status update with equal or absent preferences clears early", () => {
  const canonical = session(activeActivation());
  const base = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;

  for (const preferences of [
    {},
    { effect: null, speed: null },
    { effect: 50, speed: 50 }
  ]) {
    const result = reduce(
      base,
      {
        agentSessionId: "session-1",
        commandId: "agorax-mode-1",
        ...preferences,
        requestedAtUnixMs: 100,
        source: "slash_command",
        status: "active",
        type: "agoraxMode/updateRequested",
        workspaceId: "workspace-1"
      },
      { "session-1": canonical }
    );
    assert.deepEqual(result.commands, []);
    assert.equal(result.state.updatesBySessionId["session-1"], undefined);
  }
});

test("hydration settles only when the canonical revision carries both requested preferences", () => {
  const canonical = session(activeActivation());
  let state = reduce(
    createInitialAgoraxModeActivationState(),
    { session: canonical, type: "session/upserted" },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      agentSessionId: "session-1",
      commandId: "agorax-mode-1",
      effect: 90,
      speed: 80,
      requestedAtUnixMs: 100,
      source: "slash_command",
      status: "active",
      type: "agoraxMode/updateRequested",
      workspaceId: "workspace-1"
    },
    { "session-1": canonical }
  ).state;
  state = reduce(
    state,
    {
      commandId: "agorax-mode-1",
      commandType: "agoraxMode/update",
      outcome: "timedOut",
      type: "engine/commandResult"
    },
    { "session-1": canonical }
  ).state;

  const stale = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 110,
        effect: 90,
        orchestrationIntensity: 90,
        speed: 50,
        revision: 4,
        source: "slash_command",
        status: "active"
      }
    })
  );
  state = reduce(
    state,
    { session: stale, type: "session/upserted" },
    { "session-1": stale }
  ).state;
  assert.equal(
    state.updatesBySessionId["session-1"]?.updateStatus,
    "uncertain"
  );

  const applied = session(
    activeActivation({
      currentRevision: {
        activationId: "activation-1",
        createdAtUnixMs: 120,
        effect: 90,
        orchestrationIntensity: 90,
        speed: 80,
        revision: 5,
        source: "slash_command",
        status: "active"
      }
    })
  );
  state = reduce(
    state,
    { session: applied, type: "session/upserted" },
    { "session-1": applied }
  ).state;
  assert.equal(state.updatesBySessionId["session-1"], undefined);
});

function reduce(
  state: ReturnType<typeof createInitialAgoraxModeActivationState>,
  intent: Parameters<typeof agoraxModeActivationReducer>[1],
  sessionsById: Readonly<Record<string, AgentActivitySession>> = {}
) {
  return agoraxModeActivationReducer(state, intent, { sessionsById });
}

function engineState(
  agoraxModeActivation: ReturnType<typeof createInitialAgoraxModeActivationState>
) {
  return { agoraxModeActivation } as Parameters<
    typeof selectAgoraxModeActivationPresentation
  >[0];
}

function session(
  agoraxModeActivation: AgentActivitySession["agoraxModeActivation"]
): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    agoraxModeActivation,
    updatedAtUnixMs: 100,
    workspaceId: "workspace-1"
  });
}

function activeActivation(
  overrides: Partial<
    NonNullable<AgentActivitySession["agoraxModeActivation"]>
  > = {}
): NonNullable<AgentActivitySession["agoraxModeActivation"]> {
  return {
    agentSessionId: "session-1",
    createdAtUnixMs: 10,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 10,
      effect: 50,
      orchestrationIntensity: 50,
      speed: 50,
      revision: 3,
      source: "slash_command",
      status: "active"
    },
    id: "activation-1",
    status: "active",
    updatedAtUnixMs: 10,
    workspaceId: "workspace-1",
    ...overrides
  };
}
