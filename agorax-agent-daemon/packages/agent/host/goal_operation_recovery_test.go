package agenthost

import (
	"context"
	"sync"
	"testing"
	"time"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

type goalWorkerRuntime struct {
	RuntimeController

	mu            sync.Mutex
	sessions      map[string]ProviderRuntimeSession
	controlCalls  []RuntimeGoalControlInput
	controlHook   func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error)
	reconcileHook func(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error)
	policy        RuntimeGoalRecoveryPolicy
}

func (r *goalWorkerRuntime) Session(workspaceID, agentSessionID string) (ProviderRuntimeSession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[workspaceID+":"+agentSessionID]
	return session, ok
}

func (*goalWorkerRuntime) CanResume(RuntimeResumeInput) bool {
	return false
}

func (*goalWorkerRuntime) Resume(
	context.Context,
	RuntimeResumeInput,
) (ProviderRuntimeSession, error) {
	return ProviderRuntimeSession{}, context.DeadlineExceeded
}

func (r *goalWorkerRuntime) GoalControl(
	ctx context.Context,
	input RuntimeGoalControlInput,
) (RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.controlCalls = append(r.controlCalls, input)
	hook := r.controlHook
	r.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return RuntimeGoalControlResult{}, nil
}

func (r *goalWorkerRuntime) ReconcileGoal(
	ctx context.Context,
	input RuntimeGoalControlInput,
) (RuntimeGoalReconcileResult, error) {
	r.mu.Lock()
	hook := r.reconcileHook
	r.mu.Unlock()
	if hook != nil {
		return hook(ctx, input)
	}
	return RuntimeGoalReconcileResult{}, nil
}

func (r *goalWorkerRuntime) GoalRecoveryPolicy(
	context.Context,
	RuntimeGoalControlInput,
) (RuntimeGoalRecoveryPolicy, error) {
	return r.policy, nil
}

func (r *goalWorkerRuntime) setSession(session ProviderRuntimeSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[session.WorkspaceID+":"+session.ID] = session
}

func (r *goalWorkerRuntime) recordedControlCalls() []RuntimeGoalControlInput {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RuntimeGoalControlInput(nil), r.controlCalls...)
}

func seedGoalWorkerSession(
	t *testing.T,
	store *storesqlite.Store,
	workspaceID string,
	sessionID string,
	provider string,
) storesqlite.Session {
	t.Helper()
	session := storesqlite.Session{
		ID: sessionID, WorkspaceID: workspaceID, Kind: storesqlite.SessionKindRoot,
		Provider: provider, ProviderSessionID: provider + "-session",
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, Provider: provider,
		ProviderSessionID: session.ProviderSessionID, OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	return session
}

func prepareGoalWorkerOperation(
	t *testing.T,
	store *storesqlite.Store,
	input storesqlite.GoalControlOperationPrepare,
) {
	t.Helper()
	if _, _, _, err := store.PrepareGoalControlOperation(t.Context(), input); err != nil {
		t.Fatalf("prepare goal operation: %v", err)
	}
}

func goalWorkerCanonicalStore(session storesqlite.Session) goalCommandCanonicalStore {
	return goalCommandCanonicalStore{session: session}
}

func TestGoalClearRepeatedTimeoutEventuallyFails(t *testing.T) {
	store := openGoalOperationWorkerStore(t)
	session := seedGoalWorkerSession(t, store, "workspace-clear-timeout", "session-1", "claude-code")
	prepareGoalWorkerOperation(t, store, storesqlite.GoalControlOperationPrepare{
		OperationID: "clear-timeout", WorkspaceID: session.WorkspaceID,
		AgentSessionID: session.ID, Action: "clear", OccurredAtUnixMS: 20,
	})
	runtime := &goalWorkerRuntime{
		sessions: map[string]ProviderRuntimeSession{},
		controlHook: func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
			return RuntimeGoalControlResult{}, context.DeadlineExceeded
		},
	}
	runtime.setSession(ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider, Status: "ready",
	})
	now := int64(30)
	host := New(Config{
		CanonicalStore: goalWorkerCanonicalStore(session), Runtime: runtime,
		GoalStore: store, GoalRuntime: runtime, GoalClock: fixedClock{at: time.UnixMilli(now)},
		GoalMaxAttempts: 1,
	})
	if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	op, _, _ := store.GetGoalControlOperation(t.Context(), session.WorkspaceID, "clear-timeout")
	now = op.NextAttemptAtMS
	host.goalClock = fixedClock{at: time.UnixMilli(now)}
	if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetGoalControlOperation(t.Context(), session.WorkspaceID, "clear-timeout")
	if op.Status != storesqlite.GoalOperationStatusFailed {
		t.Fatalf("clear remained nonterminal: %#v", op)
	}
}

func TestGoalRuntimeUnavailableKeepsPreparedUntilFirstProviderDispatch(t *testing.T) {
	store := openGoalOperationWorkerStore(t)
	session := seedGoalWorkerSession(t, store, "workspace-runtime-late", "session-1", "claude-code")
	prepareGoalWorkerOperation(t, store, storesqlite.GoalControlOperationPrepare{
		OperationID: "runtime-late", WorkspaceID: session.WorkspaceID,
		AgentSessionID: session.ID, Action: "clear", ClientSubmitID: "submit-late-goal",
		OccurredAtUnixMS: 20,
	})
	runtime := &goalWorkerRuntime{
		sessions: map[string]ProviderRuntimeSession{},
		controlHook: func(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
			return RuntimeGoalControlResult{}, context.DeadlineExceeded
		},
	}
	now := int64(20)
	host := New(Config{
		CanonicalStore: goalWorkerCanonicalStore(session), Runtime: runtime,
		GoalStore: store, GoalRuntime: runtime, GoalClock: fixedClock{at: time.UnixMilli(now)},
		GoalMaxAttempts: 1,
	})
	if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	op, _, _ := store.GetGoalControlOperation(t.Context(), session.WorkspaceID, "runtime-late")
	if op.Status != storesqlite.GoalOperationStatusPrepared ||
		op.ProviderPhase != storesqlite.GoalProviderPhasePrepared ||
		op.FirstDispatchedAtUnixMS != 0 || op.LeaseOwner != "" ||
		op.NextAttemptAtMS <= now || len(runtime.recordedControlCalls()) != 0 {
		t.Fatalf("unavailable runtime advanced delivery: %#v calls=%#v", op, runtime.recordedControlCalls())
	}

	runtime.setSession(ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider, Status: "ready",
	})
	now = op.NextAttemptAtMS
	host.goalClock = fixedClock{at: time.UnixMilli(now)}
	if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetGoalControlOperation(t.Context(), session.WorkspaceID, "runtime-late")
	calls := runtime.recordedControlCalls()
	if op.Status != storesqlite.GoalOperationStatusDispatched ||
		op.FirstDispatchedAtUnixMS != now || len(calls) != 1 {
		t.Fatalf("first dispatch=%#v calls=%#v", op, calls)
	}
	if calls[0].SubmissionMetadata["clientSubmitId"] != "submit-late-goal" {
		t.Fatalf("submission metadata=%#v", calls[0].SubmissionMetadata)
	}

	now = op.NextAttemptAtMS
	host.goalClock = fixedClock{at: time.UnixMilli(now)}
	if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	op, _, _ = store.GetGoalControlOperation(t.Context(), session.WorkspaceID, "runtime-late")
	if op.Status != storesqlite.GoalOperationStatusFailed || len(runtime.recordedControlCalls()) != 1 {
		t.Fatalf("budget terminal=%#v calls=%#v", op, runtime.recordedControlCalls())
	}
}

func TestGoalRecoveryProviderQueryAndApplyTimeoutReleaseLease(t *testing.T) {
	for _, phase := range []string{"query", "apply"} {
		t.Run(phase, func(t *testing.T) {
			store := openGoalOperationWorkerStore(t)
			session := seedGoalWorkerSession(
				t,
				store,
				"workspace-goal-hang-"+phase,
				"session-1",
				"codex",
			)
			prepareGoalWorkerOperation(t, store, storesqlite.GoalControlOperationPrepare{
				OperationID: "goal-hang-" + phase, WorkspaceID: session.WorkspaceID,
				AgentSessionID: session.ID, Action: "clear", OccurredAtUnixMS: 20,
			})
			runtime := &goalWorkerRuntime{
				sessions: map[string]ProviderRuntimeSession{},
				policy:   RuntimeGoalRecoveryPolicy{QuerySupported: true, ReplaySetAfterRestart: true},
				controlHook: func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalControlResult, error) {
					<-ctx.Done()
					return RuntimeGoalControlResult{}, ctx.Err()
				},
			}
			runtime.setSession(ProviderRuntimeSession{
				ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider, Status: "ready",
			})
			if phase == "query" {
				runtime.reconcileHook = func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
					<-ctx.Done()
					return RuntimeGoalReconcileResult{}, ctx.Err()
				}
			} else {
				runtime.reconcileHook = func(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
					return RuntimeGoalReconcileResult{Evidence: map[string]any{"confidence": "unknown"}}, nil
				}
			}
			now := int64(30)
			host := New(Config{
				CanonicalStore: goalWorkerCanonicalStore(session), Runtime: runtime,
				GoalStore: store, GoalRuntime: runtime, GoalOwner: "goal-hang-worker",
				GoalClock:          fixedClock{at: time.UnixMilli(now)},
				GoalAttemptTimeout: 500 * time.Millisecond, GoalMaxAttempts: 1,
			})
			started := time.Now()
			if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
				t.Fatalf("worker timeout: %v", err)
			}
			if elapsed := time.Since(started); elapsed > 5*time.Second {
				t.Fatalf("worker timeout took %s", elapsed)
			}
			op, found, err := store.GetGoalControlOperation(
				t.Context(),
				session.WorkspaceID,
				"goal-hang-"+phase,
			)
			if err != nil || !found || op.LeaseOwner != "" || op.NextAttemptAtMS <= now ||
				op.ProviderPhase != storesqlite.GoalProviderPhaseDispatched {
				t.Fatalf("released operation=%#v found=%v err=%v", op, found, err)
			}
			if phase == "apply" {
				now = op.NextAttemptAtMS
				host.goalClock = fixedClock{at: time.UnixMilli(now)}
				if err := host.StepGoalOperationWorker(t.Context(), false); err != nil {
					t.Fatal(err)
				}
				op, _, _ = store.GetGoalControlOperation(
					t.Context(),
					session.WorkspaceID,
					"goal-hang-"+phase,
				)
				if op.Status != storesqlite.GoalOperationStatusFailed {
					t.Fatalf("retry did not terminate: %#v", op)
				}
			}
		})
	}
}

func TestGoalRecoveryStartupBudgetBoundsHangingProvider(t *testing.T) {
	store := openGoalOperationWorkerStore(t)
	session := seedGoalWorkerSession(t, store, "workspace-startup-budget", "session-1", "codex")
	prepareGoalWorkerOperation(t, store, storesqlite.GoalControlOperationPrepare{
		OperationID: "goal-startup-budget", WorkspaceID: session.WorkspaceID,
		AgentSessionID: session.ID, Action: "clear", OccurredAtUnixMS: 20,
	})
	runtime := &goalWorkerRuntime{
		sessions: map[string]ProviderRuntimeSession{},
		policy:   RuntimeGoalRecoveryPolicy{QuerySupported: true, ReplaySetAfterRestart: true},
		reconcileHook: func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
			<-ctx.Done()
			return RuntimeGoalReconcileResult{}, ctx.Err()
		},
	}
	runtime.setSession(ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider, Status: "ready",
	})
	host := New(Config{
		CanonicalStore: goalWorkerCanonicalStore(session), Runtime: runtime,
		GoalStore: store, GoalRuntime: runtime, GoalOwner: "goal-startup-budget-worker",
		GoalClock: fixedClock{at: time.UnixMilli(30)}, GoalAttemptTimeout: time.Second,
		GoalRecoveryBudget: 500 * time.Millisecond,
	})
	started := time.Now()
	if err := host.RecoverGoalOperations(t.Context()); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("startup recovery exceeded bounded budget: %s", elapsed)
	}
	op, found, err := store.GetGoalControlOperation(
		t.Context(),
		session.WorkspaceID,
		"goal-startup-budget",
	)
	if err != nil || !found || op.LeaseOwner != "" ||
		op.Status != storesqlite.GoalOperationStatusDispatched &&
			op.Status != storesqlite.GoalOperationStatusPrepared {
		t.Fatalf("startup operation=%#v found=%v err=%v", op, found, err)
	}
}

func TestGoalReconcileFenceConflictRequeriesProvider(t *testing.T) {
	store := openGoalOperationWorkerStore(t)
	session := seedGoalWorkerSession(t, store, "workspace-goal-requery", "session-1", "codex")
	runtime := &goalWorkerRuntime{sessions: map[string]ProviderRuntimeSession{}}
	runtime.setSession(ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider, Status: "ready",
	})
	queryCount := 0
	runtime.reconcileHook = func(
		ctx context.Context,
		input RuntimeGoalControlInput,
	) (RuntimeGoalReconcileResult, error) {
		queryCount++
		if queryCount == 1 {
			_, _, _, err := store.PrepareGoalControlOperation(ctx, storesqlite.GoalControlOperationPrepare{
				OperationID: "goal-created-during-query", WorkspaceID: session.WorkspaceID,
				AgentSessionID: session.ID, Action: "set", Objective: "new desired",
				OccurredAtUnixMS: 20,
			})
			if err != nil {
				return RuntimeGoalReconcileResult{}, err
			}
			return RuntimeGoalReconcileResult{
				AgentSessionID: input.AgentSessionID,
				Evidence:       map[string]any{"confidence": "authoritative"},
			}, nil
		}
		return RuntimeGoalReconcileResult{
			AgentSessionID: input.AgentSessionID,
			Goal:           map[string]any{"objective": "new desired", "status": "active"},
			Evidence:       map[string]any{"confidence": "authoritative"},
		}, nil
	}
	host := New(Config{
		CanonicalStore: goalWorkerCanonicalStore(session), Runtime: runtime,
		GoalStore: store, GoalRuntime: runtime, GoalClock: fixedClock{at: time.UnixMilli(30)},
	})
	result, err := host.ReconcileGoal(t.Context(), SessionRef{
		WorkspaceID:    session.WorkspaceID,
		AgentSessionID: session.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if queryCount != 2 {
		t.Fatalf("provider query count=%d, want 2 after fence conflict", queryCount)
	}
	if result.State.Revision != 1 || result.State.PendingOperationID != "" ||
		result.State.SyncStatus != storesqlite.GoalSyncStatusSynced ||
		result.State.Observed["objective"] != "new desired" {
		t.Fatalf("reconciled state=%#v", result.State)
	}
}

func TestManualGoalReconcileProviderTimeoutIsBounded(t *testing.T) {
	session := storesqlite.Session{
		ID: "session-timeout", WorkspaceID: "workspace-timeout",
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
	}
	runtime := &goalWorkerRuntime{
		sessions: map[string]ProviderRuntimeSession{},
		reconcileHook: func(ctx context.Context, _ RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error) {
			<-ctx.Done()
			return RuntimeGoalReconcileResult{}, ctx.Err()
		},
	}
	runtime.setSession(ProviderRuntimeSession{
		ID: session.ID, WorkspaceID: session.WorkspaceID, Provider: session.Provider, Status: "ready",
	})
	host := New(Config{
		CanonicalStore: goalWorkerCanonicalStore(session), Runtime: runtime,
		GoalRuntime: runtime, GoalAttemptTimeout: 500 * time.Millisecond,
	})
	started := time.Now()
	_, err := host.ReconcileGoal(t.Context(), SessionRef{
		WorkspaceID:    session.WorkspaceID,
		AgentSessionID: session.ID,
	})
	if err == nil || time.Since(started) > 5*time.Second {
		t.Fatalf("err=%v elapsed=%s", err, time.Since(started))
	}
}
