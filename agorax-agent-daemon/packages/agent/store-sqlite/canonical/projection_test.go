package canonical

import "testing"

func TestProjectSessionStateAppliesRuntimeContextPatchWithoutClearingCapabilities(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "workspace",
		AgentSessionID:  "session",
		Capabilities:    NewCapabilitySnapshot([]string{CapabilityGoalPause}),
		RuntimeContext:  map[string]any{"providerState": "ready", "planMode": false},
		CreatedAtUnixMS: 1,
	}
	projection := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
		RuntimeContextPatch: &RuntimeContextPatch{
			Set:   map[string]any{"planMode": true},
			Unset: []string{"missing"},
		},
	}, 2)

	if projection.Session.Capabilities == nil ||
		len(projection.Session.Capabilities.Values) != 1 ||
		projection.Session.Capabilities.Values[0] != CapabilityGoalPause {
		t.Fatalf("capabilities = %#v, want preserved goalPause", projection.Session.Capabilities)
	}
	if projection.Session.RuntimeContext["providerState"] != "ready" || projection.Session.RuntimeContext["planMode"] != true {
		t.Fatalf("runtime context = %#v", projection.Session.RuntimeContext)
	}
}

func TestProjectSessionStateDistinguishesUnknownAndReportedEmptyCapabilities(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "workspace",
		AgentSessionID:  "session",
		Capabilities:    NewCapabilitySnapshot([]string{CapabilityGoalPause}),
		CreatedAtUnixMS: 1,
	}
	preserved := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
	}, 2)
	if preserved.Session.Capabilities == nil || len(preserved.Session.Capabilities.Values) != 1 {
		t.Fatalf("unknown update capabilities = %#v, want preserved", preserved.Session.Capabilities)
	}

	replaced := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
		Capabilities:   NewCapabilitySnapshot(nil),
	}, 3)
	if replaced.Session.Capabilities == nil || len(replaced.Session.Capabilities.Values) != 0 {
		t.Fatalf("reported empty capabilities = %#v", replaced.Session.Capabilities)
	}
}

func TestProjectSessionStateTreatsEmptyRuntimeContextAsSnapshot(t *testing.T) {
	existing := SessionSnapshot{
		WorkspaceID:     "workspace",
		AgentSessionID:  "session",
		RuntimeContext:  map[string]any{"providerState": "ready"},
		CreatedAtUnixMS: 1,
	}
	projection := ProjectSessionState(existing, true, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
		RuntimeContext: map[string]any{},
	}, 2)
	if len(projection.Session.RuntimeContext) != 0 {
		t.Fatalf("runtime context = %#v, want explicit empty snapshot", projection.Session.RuntimeContext)
	}
}

func TestProjectSessionStateRejectsRuntimeContextSnapshotAndPatchTogether(t *testing.T) {
	projection := ProjectSessionState(SessionSnapshot{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
	}, true, SessionStateReport{
		WorkspaceID:         "workspace",
		AgentSessionID:      "session",
		RuntimeContext:      map[string]any{},
		RuntimeContextPatch: &RuntimeContextPatch{Set: map[string]any{"planMode": true}},
	}, 2)

	if projection.InvalidReason != SessionProjectionInvalidRuntimeContextUpdate {
		t.Fatalf("invalid reason = %q", projection.InvalidReason)
	}
	if projection.Accepted {
		t.Fatal("accepted = true, want invalid projection rejected")
	}
}

func TestProjectSessionStateRejectsReservedRuntimeContextPatchKey(t *testing.T) {
	projection := ProjectSessionState(SessionSnapshot{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
	}, true, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
		RuntimeContextPatch: &RuntimeContextPatch{
			Set: map[string]any{"capabilities": []string{CapabilityGoalPause}},
		},
	}, 2)

	if projection.InvalidReason != SessionProjectionInvalidRuntimeContextPatchKey {
		t.Fatalf("invalid reason = %q", projection.InvalidReason)
	}
}
