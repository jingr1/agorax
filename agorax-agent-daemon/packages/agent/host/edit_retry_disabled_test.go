package agenthost_test

import (
	"errors"
	"testing"
	"time"

	agenthost "agorax.local/agent-daemon/packages/agent/host"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

// newDisabledEditRetryHost builds a second Host over an existing fixture
// store+runtime with the edit-and-retry feature neutralized, mirroring how
// production wires composeApplicationHost with EditRetryDisabled: true.
func newDisabledEditRetryHost(store *storesqlite.Store, runtime *hostEditRetryRuntime) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore:  sqliteCanonicalStore{Store: store},
		TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime,
		OperationOwner:    "worker-disabled",
		EditRetryDisabled: true,
	})
}

// TestEditRetryDisabledRefusesNewOperations verifies the entry points are
// neutralized: availability reports unsupported (so the GUI hides the affordance)
// and EditRetry refuses without creating any durable runtime operation.
func TestEditRetryDisabledRefusesNewOperations(t *testing.T) {
	_, store, runtime := newHostEditRetryFixture(t)
	host := newDisabledEditRetryHost(store, runtime)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	availability, err := host.GetEditRetryAvailability(t.Context(), ref)
	if err != nil {
		t.Fatalf("GetEditRetryAvailability() error = %v", err)
	}
	if availability.Supported || availability.Eligible {
		t.Fatalf("availability = %#v, want Supported=false Eligible=false", availability)
	}

	_, err = host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-1", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrRuntimeHistoryUnsupported) {
		t.Fatalf("EditRetry() error = %v, want ErrRuntimeHistoryUnsupported", err)
	}

	claimable, err := store.ListClaimableRuntimeOperations(t.Context(), storesqlite.ListClaimableRuntimeOperationsInput{
		NowUnixMS: 1 << 62, Limit: 100,
	})
	if err != nil {
		t.Fatalf("ListClaimableRuntimeOperations() error = %v", err)
	}
	if len(claimable) != 0 {
		t.Fatalf("EditRetry(disabled) created %d runtime operation(s), want 0", len(claimable))
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 0 || runtime.execCalls != 0 {
		t.Fatalf("provider was touched: rollback=%d exec=%d, want 0,0", runtime.rollbackCalls, runtime.execCalls)
	}
}

// TestEditRetryDisabledQuarantinesStuckOperationDuringRecovery is the crash
// regression guard. It creates a genuinely stuck edit-retry operation (rolled
// back, replacement never landed — the exact state from the incident), proves
// that recovering it with the feature ENABLED is fatal to the boot pass, and
// proves that with the feature DISABLED recovery instead quarantines it and
// returns nil so agoraxd can start.
func TestEditRetryDisabledQuarantinesStuckOperationDuringRecovery(t *testing.T) {
	enabled, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	// Drive a real edit-retry whose replacement dispatch never lands, leaving a
	// claimable operation parked at the resend-pending checkpoint.
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	result, err := enabled.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-stuck", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	operationID := result.OperationID
	if operationID == "" {
		t.Fatal("EditRetry() returned empty operation id")
	}

	// The stuck operation fences the session's effective history, which blocks
	// every subsequent send until the fence returns to ready.
	if history, found, herr := store.GetSessionHistory(t.Context(), "workspace-1", "session-1"); herr != nil || !found ||
		history.RecoveryState != storesqlite.SessionHistoryRecoveryResendPending {
		t.Fatalf("pre-quarantine recovery_state = %q found=%v error=%v, want %q",
			history.RecoveryState, found, herr, storesqlite.SessionHistoryRecoveryResendPending)
	}

	// With the feature enabled, cold recovery of the stuck operation is fatal —
	// this is the boot crash the neutralization fixes.
	if recErr := enabled.RecoverRuntimeOperations(t.Context()); recErr == nil {
		t.Fatal("RecoverRuntimeOperations(enabled) = nil, want the stuck operation to surface a boot-fatal error")
	}

	runtime.mu.Lock()
	rollbackBefore, execBefore, readsBefore := runtime.rollbackCalls, runtime.execCalls, runtime.historyReads
	runtime.mu.Unlock()

	// With the feature disabled, recovery must quarantine the operation and
	// return nil so the daemon can finish booting.
	disabled := newDisabledEditRetryHost(store, runtime)
	if recErr := disabled.RecoverRuntimeOperations(t.Context()); recErr != nil {
		t.Fatalf("RecoverRuntimeOperations(disabled) = %v, want nil (must not abort boot)", recErr)
	}

	operation, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", operationID)
	if err != nil {
		t.Fatalf("GetRuntimeOperation() error = %v", err)
	}
	if !found || operation.Status != storesqlite.RuntimeOperationStatusFailed {
		t.Fatalf("operation status = %q found=%v, want %q", operation.Status, found, storesqlite.RuntimeOperationStatusFailed)
	}

	// The session fence must be cleared back to ready, otherwise the daemon boots
	// but the conversation can never send another message.
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found {
		t.Fatalf("GetSessionHistory() found=%v error=%v", found, err)
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		t.Fatalf("post-quarantine recovery_state = %q, want %q (session must be able to send again)",
			history.RecoveryState, storesqlite.SessionHistoryRecoveryReady)
	}

	// Quarantine is a pure store transition: it must not re-engage the provider.
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != rollbackBefore || runtime.execCalls != execBefore || runtime.historyReads != readsBefore {
		t.Fatalf(
			"disabled recovery touched provider: rollback %d->%d exec %d->%d reads %d->%d",
			rollbackBefore, runtime.rollbackCalls, execBefore, runtime.execCalls, readsBefore, runtime.historyReads,
		)
	}
}

// TestEditRetryDisabledHealsLegacyFencedSessionOnSend covers sessions fenced
// BEFORE the feature was neutralized: the operation is already failed (e.g. via
// FailEditRetryRecovery), so recovery — which only sees claimable operations —
// can never quarantine it and the fence would survive every boot. The send gate
// must self-heal such a fence so the conversation is not blocked forever.
func TestEditRetryDisabledHealsLegacyFencedSessionOnSend(t *testing.T) {
	enabled, store, runtime := newHostEditRetryFixture(t)
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	// Strand an edit-retry at resend_pending, then reproduce the legacy terminal
	// state: FailEditRetryRecovery fences the session at recovery_required and
	// fails the operation in one transaction.
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	result, err := enabled.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-legacy", ExpectedHistoryRevision: 0,
	})
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryResendPending", err)
	}
	now := time.Now().UnixMilli()
	if _, claimed, claimErr := store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "workspace-1", OperationID: result.OperationID,
		LeaseOwner: "legacy-worker", NowUnixMS: now, LeaseExpiresAtMS: now + 30_000,
	}); claimErr != nil || !claimed {
		t.Fatalf("ClaimRuntimeOperationLease() claimed=%v error=%v", claimed, claimErr)
	}
	if _, changed, failErr := store.FailEditRetryRecovery(t.Context(), storesqlite.FailEditRetryRecoveryInput{
		WorkspaceID: "workspace-1", OperationID: result.OperationID, LeaseOwner: "legacy-worker",
		ReasonCode: storesqlite.EditRetryReasonRecoveryRequired, NowUnixMS: now,
	}); failErr != nil || !changed {
		t.Fatalf("FailEditRetryRecovery() changed=%v error=%v", changed, failErr)
	}
	if history, _, _ := store.GetSessionHistory(t.Context(), "workspace-1", "session-1"); history.RecoveryState != storesqlite.SessionHistoryRecoveryRequired {
		t.Fatalf("legacy recovery_state = %q, want %q", history.RecoveryState, storesqlite.SessionHistoryRecoveryRequired)
	}

	// Guard: the enabled host's send gate rejects this state, proving SendInput
	// reaches the effective-history fence in this fixture.
	prompt := agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "hello again"}}}
	if _, sendErr := enabled.SendInput(t.Context(), ref, prompt); !errors.Is(sendErr, agenthost.ErrEditRetryRecoveryRequired) {
		t.Fatalf("SendInput(enabled) error = %v, want ErrEditRetryRecoveryRequired", sendErr)
	}

	// Recovery on the disabled host is non-fatal but cannot see the failed
	// operation, so the fence survives the boot pass.
	disabled := newDisabledEditRetryHost(store, runtime)
	if recErr := disabled.RecoverRuntimeOperations(t.Context()); recErr != nil {
		t.Fatalf("RecoverRuntimeOperations(disabled) = %v, want nil", recErr)
	}
	if history, _, _ := store.GetSessionHistory(t.Context(), "workspace-1", "session-1"); history.RecoveryState != storesqlite.SessionHistoryRecoveryRequired {
		t.Fatalf("post-recovery recovery_state = %q, want it untouched (%q)", history.RecoveryState, storesqlite.SessionHistoryRecoveryRequired)
	}

	// The first send self-heals the abandoned fence and proceeds past the gate.
	if _, sendErr := disabled.SendInput(t.Context(), ref, prompt); errors.Is(sendErr, agenthost.ErrEditRetryRecoveryRequired) ||
		errors.Is(sendErr, agenthost.ErrEditRetryResendPending) || errors.Is(sendErr, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("SendInput(disabled) error = %v, want the fence error healed", sendErr)
	}
	history, found, err := store.GetSessionHistory(t.Context(), "workspace-1", "session-1")
	if err != nil || !found {
		t.Fatalf("GetSessionHistory() found=%v error=%v", found, err)
	}
	if history.RecoveryState != storesqlite.SessionHistoryRecoveryReady {
		t.Fatalf("post-send recovery_state = %q, want %q", history.RecoveryState, storesqlite.SessionHistoryRecoveryReady)
	}
}
