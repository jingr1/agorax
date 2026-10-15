package storesqlite

import (
	"context"
	"testing"

	"agorax.local/agent-daemon/packages/agent/store-sqlite/canonical"
)

func TestSessionCapabilitySnapshotSurvivesRuntimeContextPatch(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "workspace",
		AgentSessionID:   "session",
		Provider:         "codex",
		Capabilities:     canonical.NewCapabilitySnapshot([]string{canonical.CapabilityGoalPause}),
		RuntimeContext:   map[string]any{"providerState": "ready", "planMode": false},
		OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session",
		RuntimeContextPatch: &canonical.RuntimeContextPatch{
			Set: map[string]any{"planMode": true},
		},
		OccurredAtUnixMS: 2,
	}); err != nil {
		t.Fatal(err)
	}

	session, ok, err := store.GetSession(ctx, "workspace", "session")
	if err != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v", ok, err)
	}
	if session.Capabilities == nil || len(session.Capabilities.Values) != 1 || session.Capabilities.Values[0] != canonical.CapabilityGoalPause {
		t.Fatalf("capabilities = %#v", session.Capabilities)
	}
	if session.InternalRuntimeContext["providerState"] != "ready" || session.InternalRuntimeContext["planMode"] != true {
		t.Fatalf("runtime context = %#v", session.InternalRuntimeContext)
	}
}

func TestSessionStateRejectsRuntimeContextSnapshotAndPatchTogether(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	_, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID:         "workspace",
		AgentSessionID:      "session",
		RuntimeContext:      map[string]any{},
		RuntimeContextPatch: &canonical.RuntimeContextPatch{Set: map[string]any{"planMode": true}},
	})
	if err == nil {
		t.Fatal("ReportSessionState() error=nil, want conflicting runtime context rejection")
	}
}

func TestSessionCapabilitySnapshotPersistsReportedEmpty(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "workspace",
		AgentSessionID: "session-empty",
		Provider:       "codex",
		Capabilities:   canonical.NewCapabilitySnapshot(nil),
	}); err != nil {
		t.Fatal(err)
	}
	session, ok, err := store.GetSession(ctx, "workspace", "session-empty")
	if err != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v", ok, err)
	}
	if session.Capabilities == nil || len(session.Capabilities.Values) != 0 {
		t.Fatalf("reported empty capabilities = %#v", session.Capabilities)
	}
}
