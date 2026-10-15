package agenthost

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func openGoalOperationWorkerStore(t *testing.T) *storesqlite.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "goal-operation-worker.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	return store
}

type goalCommandCanonicalStore struct {
	CanonicalStore
	session storesqlite.Session
}

func (goalCommandCanonicalStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s goalCommandCanonicalStore) GetSession(context.Context, string, string) (storesqlite.Session, bool, error) {
	return s.session, true, nil
}

func (goalCommandCanonicalStore) GetProviderSessionResumeEvidence(
	context.Context,
	string,
	string,
) (storesqlite.ProviderSessionResumeEvidence, error) {
	return storesqlite.ProviderSessionResumeEvidence{HasTurns: true, Established: true}, nil
}

type goalCommandRuntime struct {
	RuntimeController
	session ProviderRuntimeSession
}

func (r goalCommandRuntime) Session(workspaceID string, agentSessionID string) (ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
}

type blockingGoalRuntime struct {
	mu         sync.Mutex
	actions    []string
	setEntered chan struct{}
	releaseSet chan struct{}
	setErr     error
	policy     RuntimeGoalRecoveryPolicy
}

func (r *blockingGoalRuntime) GoalControl(ctx context.Context, input RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.actions = append(r.actions, input.Action)
	r.mu.Unlock()
	if input.Action == "set" {
		close(r.setEntered)
		select {
		case <-ctx.Done():
			return RuntimeGoalControlResult{}, ctx.Err()
		case <-r.releaseSet:
		}
		if r.setErr != nil {
			return RuntimeGoalControlResult{}, r.setErr
		}
		return RuntimeGoalControlResult{Goal: map[string]any{"objective": input.Objective, "status": "active"}}, nil
	}
	return RuntimeGoalControlResult{}, nil
}

func (r *blockingGoalRuntime) GoalRecoveryPolicy(
	context.Context,
	RuntimeGoalControlInput,
) (RuntimeGoalRecoveryPolicy, error) {
	return r.policy, nil
}

func (r *blockingGoalRuntime) recordedActions() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.actions...)
}

func TestGoalCommandsSerializeProviderMutations(t *testing.T) {
	canonical := storesqlite.Session{
		ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
		Provider: "codex", ProviderSessionID: "provider-session-1",
	}
	runtimeSession := ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "provider-session-1",
	}
	goalRuntime := &blockingGoalRuntime{setEntered: make(chan struct{}), releaseSet: make(chan struct{})}
	host := New(Config{
		CanonicalStore: goalCommandCanonicalStore{session: canonical},
		Runtime:        goalCommandRuntime{session: runtimeSession},
		GoalRuntime:    goalRuntime,
	})
	setDone := make(chan error, 1)
	go func() {
		_, err := host.GoalControl(context.Background(), GoalControlInput{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", Action: "set", Objective: "ship it",
		})
		setDone <- err
	}()
	<-goalRuntime.setEntered
	clearDone := make(chan error, 1)
	go func() {
		_, err := host.GoalControl(context.Background(), GoalControlInput{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", Action: "clear",
		})
		clearDone <- err
	}()
	time.Sleep(20 * time.Millisecond)
	if got := goalRuntime.recordedActions(); !reflect.DeepEqual(got, []string{"set"}) {
		t.Fatalf("provider actions before set completion = %#v", got)
	}
	close(goalRuntime.releaseSet)
	if err := <-setDone; err != nil {
		t.Fatalf("set goal: %v", err)
	}
	if err := <-clearDone; err != nil {
		t.Fatalf("clear goal: %v", err)
	}
	if got := goalRuntime.recordedActions(); !reflect.DeepEqual(got, []string{"set", "clear"}) {
		t.Fatalf("provider actions = %#v", got)
	}
}

func TestGoalCommandsReleaseMutationLaneAfterProviderFailure(t *testing.T) {
	store := openGoalOperationWorkerStore(t)
	canonical := storesqlite.Session{
		ID: "session-1", WorkspaceID: "workspace-1", Kind: storesqlite.SessionKindRoot,
		Provider: "claude-code", ProviderSessionID: "provider-session-1",
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: canonical.WorkspaceID, AgentSessionID: canonical.ID,
		Provider: canonical.Provider, ProviderSessionID: canonical.ProviderSessionID,
		OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	runtimeSession := ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "claude-code",
		ProviderSessionID: "provider-session-1",
	}
	goalRuntime := &blockingGoalRuntime{
		setEntered: make(chan struct{}),
		releaseSet: make(chan struct{}),
		setErr:     context.DeadlineExceeded,
	}
	host := New(Config{
		CanonicalStore: goalCommandCanonicalStore{session: canonical},
		Runtime:        goalCommandRuntime{session: runtimeSession},
		GoalStore:      store,
		GoalRuntime:    goalRuntime,
	})
	setDone := make(chan error, 1)
	go func() {
		_, err := host.GoalControl(context.Background(), GoalControlInput{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", Action: "set", Objective: "old",
		})
		setDone <- err
	}()
	<-goalRuntime.setEntered
	clearDone := make(chan error, 1)
	go func() {
		_, err := host.GoalControl(context.Background(), GoalControlInput{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", Action: "clear",
		})
		clearDone <- err
	}()
	close(goalRuntime.releaseSet)
	if err := <-setDone; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("set goal error = %v, want deadline exceeded", err)
	}
	if err := <-clearDone; err != nil {
		t.Fatalf("clear goal after failed set: %v", err)
	}
	if got := goalRuntime.recordedActions(); !reflect.DeepEqual(got, []string{"set", "clear"}) {
		t.Fatalf("provider actions = %#v, want failed set then clear", got)
	}
	state, found, err := store.GetSessionGoalState(t.Context(), canonical.WorkspaceID, canonical.ID)
	if err != nil || !found || state.Revision != 2 || !state.Tombstoned ||
		len(state.Desired) != 0 || state.SyncStatus != storesqlite.GoalSyncStatusSynced ||
		state.PendingOperationID != "" {
		t.Fatalf("goal state = %#v, found = %v, error = %v", state, found, err)
	}
}

func TestResolveRuntimeGoalRecoveryPolicyUsesOptionalCapability(t *testing.T) {
	runtime := &blockingGoalRuntime{
		policy: RuntimeGoalRecoveryPolicy{QuerySupported: true, ReplaySetAfterRestart: true},
	}
	policy, err := ResolveRuntimeGoalRecoveryPolicy(
		context.Background(),
		runtime,
		RuntimeGoalControlInput{},
	)
	if err != nil || !policy.QuerySupported || !policy.ReplaySetAfterRestart {
		t.Fatalf("resolved policy = %#v, error = %v", policy, err)
	}

	// Hiding the optional resolver models an unknown or older adapter. Host
	// must fail closed instead of assuming replay or query support.
	unknown := struct{ GoalRuntimeController }{GoalRuntimeController: runtime}
	policy, err = ResolveRuntimeGoalRecoveryPolicy(
		context.Background(),
		unknown,
		RuntimeGoalControlInput{},
	)
	if err != nil || policy.QuerySupported || policy.ReplaySetAfterRestart {
		t.Fatalf("missing-resolver policy = %#v, error = %v", policy, err)
	}
}

type retryRecordingGoalStore struct {
	GoalStateStore
	current  storesqlite.GoalControlOperation
	released []storesqlite.ReleaseGoalControlOperationInput
}

func (s *retryRecordingGoalStore) GetGoalControlOperation(context.Context, string, string) (storesqlite.GoalControlOperation, bool, error) {
	return s.current, true, nil
}

func (s *retryRecordingGoalStore) ReleaseGoalControlOperation(_ context.Context, input storesqlite.ReleaseGoalControlOperationInput) (storesqlite.GoalControlOperation, bool, error) {
	s.released = append(s.released, input)
	return s.current, true, nil
}

func TestRetryRecoveredGoalOperationPreservesRepairEvidence(t *testing.T) {
	store := &retryRecordingGoalStore{current: storesqlite.GoalControlOperation{
		OperationID: "repair-op", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		GoalRevision: 2, LeaseOwner: "goal-worker", RepairEpoch: 3, Attempt: 1,
		Evidence: map[string]any{"repair": map[string]any{"repairId": "incident-1"}},
	}}
	host := New(Config{GoalStore: store, GoalOwner: "goal-worker", GoalClock: fixedClock{at: time.UnixMilli(1_000)}})
	if err := host.retryRecoveredGoalOperation(context.Background(), store.current, context.DeadlineExceeded); err != nil {
		t.Fatal(err)
	}
	if len(store.released) != 1 {
		t.Fatalf("release inputs = %#v", store.released)
	}
	repair, ok := store.released[0].Evidence["repair"].(map[string]any)
	if !ok || repair["repairId"] != "incident-1" || store.released[0].RepairEpoch != 3 {
		t.Fatalf("release evidence = %#v", store.released[0])
	}
}

type fixedClock struct{ at time.Time }

func (c fixedClock) Now() time.Time { return c.at }
