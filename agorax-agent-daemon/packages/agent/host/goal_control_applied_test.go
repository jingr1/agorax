package agenthost

import (
	"context"
	"testing"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

type registeringGoalRuntime struct {
	sink RuntimeGoalControlAppliedSink
}

func (*registeringGoalRuntime) GoalControl(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
	return RuntimeGoalControlResult{}, nil
}

func (r *registeringGoalRuntime) SetGoalControlAppliedSink(sink RuntimeGoalControlAppliedSink) {
	r.sink = sink
}

func TestHostRegistersGoalControlLifecycleWithStandardRuntimePort(t *testing.T) {
	t.Parallel()
	runtime := &registeringGoalRuntime{}
	New(Config{GoalRuntime: runtime})
	if runtime.sink == nil {
		t.Fatal("Host did not register its Goal lifecycle sink")
	}
}

func TestObserveRuntimeGoalControlAppliedCompletesOnlyExactOperation(t *testing.T) {
	t.Parallel()
	store := openGoalOperationWorkerStore(t)
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace", AgentSessionID: "session", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, _, err := store.PrepareGoalControlOperation(t.Context(), storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-op-1", WorkspaceID: "workspace", AgentSessionID: "session",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.MarkGoalControlOperationDispatched(t.Context(), "workspace", operation.OperationID, 21); err != nil || !changed {
		t.Fatalf("dispatch changed=%v error=%v", changed, err)
	}

	host := New(Config{GoalStore: store})
	stale := RuntimeGoalControlAppliedInput{
		WorkspaceID: "workspace", AgentSessionID: "session", OperationID: operation.OperationID,
		GoalRevision: operation.GoalRevision + 1, Action: "set",
		Observed: map[string]any{"objective": "ship it", "status": "active"}, OccurredAtUnixMS: 30,
	}
	if err := host.ObserveRuntimeGoalControlApplied(t.Context(), stale); err != nil {
		t.Fatal(err)
	}
	persisted, found, err := store.GetGoalControlOperation(t.Context(), "workspace", operation.OperationID)
	if err != nil || !found || persisted.Status != storesqlite.GoalOperationStatusDispatched {
		t.Fatalf("stale observation changed operation=%#v found=%v error=%v", persisted, found, err)
	}

	exact := stale
	exact.GoalRevision = operation.GoalRevision
	exact.ProviderTurnID = "provider-turn-1"
	exact.OccurredAtUnixMS = 31
	if err := host.ObserveRuntimeGoalControlApplied(t.Context(), exact); err != nil {
		t.Fatal(err)
	}
	persisted, found, err = store.GetGoalControlOperation(t.Context(), "workspace", operation.OperationID)
	if err != nil || !found || persisted.Status != storesqlite.GoalOperationStatusCompleted || persisted.ProviderPhase != storesqlite.GoalProviderPhaseApplied {
		t.Fatalf("exact observation operation=%#v found=%v error=%v", persisted, found, err)
	}
	state, found, err := store.GetSessionGoalState(t.Context(), "workspace", "session")
	if err != nil || !found || state.SyncStatus != storesqlite.GoalSyncStatusSynced || state.PendingOperationID != "" {
		t.Fatalf("exact observation state=%#v found=%v error=%v", state, found, err)
	}
	if state.LastEvidence["source"] != "runtime_goal_control_lifecycle" || state.LastEvidence["providerTurnId"] != "provider-turn-1" {
		t.Fatalf("exact observation evidence=%#v", state.LastEvidence)
	}

	if err := host.ObserveRuntimeGoalControlApplied(t.Context(), exact); err != nil {
		t.Fatalf("duplicate observation: %v", err)
	}
}
