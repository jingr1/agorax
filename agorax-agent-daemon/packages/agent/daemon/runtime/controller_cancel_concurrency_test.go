package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

func TestControllerCancelCancelsActiveTurnContextWhenAdapterReturnsNoEvents(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("long prompt"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "long prompt")

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput(started.Session.RoomID, started.Session.AgentSessionID, execResult.TurnID, "user_interrupt"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want canceled active turn", cancelResult)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
}

func TestControllerCancelInvokesProviderBeforeCancelingActiveTurnContext(t *testing.T) {
	t.Parallel()

	adapter := newCancelOrderingAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         started.Session.RoomID,
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("long prompt"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.execStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not start")
	}

	result, err := controller.Cancel(context.Background(), rootCancelInput(
		started.Session.RoomID,
		started.Session.AgentSessionID,
		execResult.TurnID,
		"user_interrupt",
	))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !result.Canceled {
		t.Fatalf("Cancel result = %#v, want canceled", result)
	}
	select {
	case observed := <-adapter.providerCancelObservedContextError:
		if observed != nil {
			t.Fatalf("provider Cancel observed Exec context error = %v, want live context", observed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("provider Cancel was not invoked")
	}
	select {
	case <-adapter.execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Exec context was not canceled after provider Cancel returned")
	}
}

func TestControllerCancelKeepsActiveTurnUntilAdapterFinishes(t *testing.T) {
	t.Parallel()

	adapter := newDeferredRemoteCancelAdapter()
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("first"),
	})
	if err != nil {
		t.Fatalf("Exec first turn: %v", err)
	}
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusWorking)

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, execResult.TurnID, "user_interrupt"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want active turn cancel", cancelResult)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("second"),
	}); !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("Exec while remote cancel is still settling error = %v, want %v", err, ErrSessionActiveTurn)
	}
	current, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after cancel")
	}
	if current.Status != SessionStatusWorking {
		t.Fatalf("session status after cancel = %q, want %q until adapter finishes", current.Status, SessionStatusWorking)
	}

	close(adapter.releaseExec)
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
}

type cancelOrderingAdapter struct {
	mu                                 sync.Mutex
	execContext                        context.Context
	execStarted                        chan struct{}
	execDone                           chan struct{}
	providerCancelObservedContextError chan error
}

func newCancelOrderingAdapter() *cancelOrderingAdapter {
	return &cancelOrderingAdapter{
		execStarted:                        make(chan struct{}),
		execDone:                           make(chan struct{}),
		providerCancelObservedContextError: make(chan error, 1),
	}
}

func (*cancelOrderingAdapter) Provider() string { return ProviderCodex }

func (*cancelOrderingAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*cancelOrderingAdapter) Resume(context.Context, Session) error { return nil }

func (*cancelOrderingAdapter) Close(context.Context, Session) error { return nil }

func (a *cancelOrderingAdapter) Exec(ctx context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	a.mu.Lock()
	a.execContext = ctx
	a.mu.Unlock()
	close(a.execStarted)
	emit([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	<-ctx.Done()
	close(a.execDone)
	return nil, ctx.Err()
}

func (a *cancelOrderingAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.mu.Lock()
	execCtx := a.execContext
	a.mu.Unlock()
	var observed error
	if execCtx != nil {
		observed = execCtx.Err()
	}
	a.providerCancelObservedContextError <- observed
	return nil, nil
}

type deferredRemoteCancelAdapter struct {
	releaseExec      chan struct{}
	cancelRequested  chan struct{}
	cancelRequestMux sync.Once
}

func newDeferredRemoteCancelAdapter() *deferredRemoteCancelAdapter {
	return &deferredRemoteCancelAdapter{
		releaseExec:     make(chan struct{}),
		cancelRequested: make(chan struct{}),
	}
}

func (*deferredRemoteCancelAdapter) Provider() string { return ProviderCodex }

func (*deferredRemoteCancelAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*deferredRemoteCancelAdapter) Resume(context.Context, Session) error { return nil }

func (*deferredRemoteCancelAdapter) Close(context.Context, Session) error { return nil }

func (a *deferredRemoteCancelAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	<-a.releaseExec
	select {
	case <-a.cancelRequested:
		return []activityshared.Event{
			newSessionActivityEvent(session, EventSessionCanceled, SessionStatusCanceled, map[string]any{
				"reason": "user_interrupt",
			}),
			newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"reason": "user_interrupt",
			}),
		}, nil
	default:
		return []activityshared.Event{
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
		}, nil
	}
}

func (a *deferredRemoteCancelAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelRequestMux.Do(func() {
		close(a.cancelRequested)
	})
	return nil, nil
}

func TestControllerExactTurnCancelDoesNotCancelNewerActiveTurn(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	controller.store(Session{
		RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderCodex,
		ProviderSessionID: "prov-1", Status: SessionStatusWorking,
	})
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-1")] = activeTurn{turnID: "turn-new"}
	controller.mu.Unlock()

	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", "agent-1", "turn-old", "user"))
	if err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if result.Canceled {
		t.Fatalf("Cancel() result = %#v, want not canceled", result)
	}
	if adapter.cancelCalls != 0 {
		t.Fatalf("adapter cancel calls = %d, want 0", adapter.cancelCalls)
	}
	active, ok := controller.activeTurn("room-1", "agent-1")
	if !ok || active.turnID != "turn-new" {
		t.Fatalf("active turn after exact cancel = %#v, %v, want turn-new", active, ok)
	}
}

func TestControllerExactTurnCancelHoldsLifecycleLockThroughAdapterCancel(t *testing.T) {
	t.Parallel()

	cancelEntered := make(chan struct{}, 1)
	cancelReleased := make(chan struct{})
	adapter := &recordingStartAdapter{
		provider: ProviderCodex, cancelEntered: cancelEntered, cancelReleased: cancelReleased,
	}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	controller.store(Session{
		RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderCodex,
		ProviderSessionID: "prov-1", Status: SessionStatusWorking,
	})
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-1")] = activeTurn{turnID: "turn-1"}
	controller.mu.Unlock()

	cancelDone := make(chan error, 1)
	go func() {
		_, err := controller.Cancel(context.Background(), rootCancelInput("room-1", "agent-1", "turn-1", "user"))
		cancelDone <- err
	}()
	select {
	case <-cancelEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("adapter cancel did not start")
	}

	secondLockAcquired := make(chan struct{})
	go func() {
		release := controller.acquireLifecycleLock("room-1", "agent-1")
		close(secondLockAcquired)
		release()
	}()
	select {
	case <-secondLockAcquired:
		t.Fatal("session lifecycle lock was released before adapter cancel completed")
	case <-time.After(50 * time.Millisecond):
	}

	close(cancelReleased)
	select {
	case err := <-cancelDone:
		if err != nil {
			t.Fatalf("Cancel() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Cancel() did not finish")
	}
	select {
	case <-secondLockAcquired:
	case <-time.After(2 * time.Second):
		t.Fatal("session lifecycle lock was not released after adapter cancel")
	}
}
