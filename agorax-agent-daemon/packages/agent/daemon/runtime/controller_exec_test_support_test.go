package agentruntime

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

type blockingExecAdapter struct {
	mu                  sync.Mutex
	seen                []string
	displays            []string
	contexts            chan context.Context
	started             chan string
	releases            chan struct{}
	provider            string
	interactiveOptionID string
}

func newBlockingExecAdapter() *blockingExecAdapter {
	return &blockingExecAdapter{
		contexts: make(chan context.Context, 8),
		started:  make(chan string, 8),
		releases: make(chan struct{}, 8),
	}
}

func (a *blockingExecAdapter) Provider() string {
	if a != nil && strings.TrimSpace(a.provider) != "" {
		return strings.TrimSpace(a.provider)
	}
	return ProviderCodex
}

func (*blockingExecAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*blockingExecAdapter) Resume(context.Context, Session) error { return nil }

func (*blockingExecAdapter) Close(context.Context, Session) error { return nil }

func (a *blockingExecAdapter) Exec(ctx context.Context, session Session, content []PromptContentBlock, displayPrompt string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	prompt := promptDisplayText(content)
	a.mu.Lock()
	a.seen = append(a.seen, prompt)
	a.displays = append(a.displays, displayPrompt)
	a.mu.Unlock()
	a.contexts <- ctx
	emit([]activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	a.started <- prompt
	select {
	case <-a.releases:
		return []activityshared.Event{
			newTurnActivityEvent(session, EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (*blockingExecAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *blockingExecAdapter) SubmitInteractive(_ context.Context, session Session, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	optionID := strings.TrimSpace(a.interactiveOptionID)
	if optionID == "" {
		optionID = strings.TrimSpace(input.OptionID)
	}
	if optionID == "" && input.Payload != nil {
		optionID = strings.TrimSpace(asString(input.Payload["optionId"]))
	}
	return SubmitInteractiveResult{
		AgentSessionID: session.AgentSessionID,
		RequestID:      strings.TrimSpace(input.RequestID),
		Accepted:       true,
		OptionID:       optionID,
	}, nil
}

func (a *blockingExecAdapter) StateAfterInteractiveSelection(
	_ Session,
	optionID string,
) (InteractiveSelectionState, bool) {
	if a.Provider() != ProviderClaudeCode {
		return InteractiveSelectionState{}, false
	}
	planMode, permissionMode, ok := claudeCodeModeFromID(optionID)
	return InteractiveSelectionState{
		PlanMode:       planMode,
		PermissionMode: permissionMode,
	}, ok
}

func (a *blockingExecAdapter) waitForPrompt(t *testing.T, prompt string) {
	t.Helper()
	select {
	case got := <-a.started:
		if got != prompt {
			t.Fatalf("started prompt = %q, want %q", got, prompt)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for prompt %q", prompt)
	}
}

func (a *blockingExecAdapter) releaseNext() {
	a.releases <- struct{}{}
}

func (a *blockingExecAdapter) prompts() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.seen...)
}

func (a *blockingExecAdapter) displayPrompts() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.displays...)
}

type blockingSessionUpdateAdapter struct {
	readyToEmit chan struct{}
	emitted     chan struct{}
	canceled    chan struct{}
	cancelOnce  sync.Once
}

func newBlockingSessionUpdateAdapter() *blockingSessionUpdateAdapter {
	return &blockingSessionUpdateAdapter{
		readyToEmit: make(chan struct{}),
		emitted:     make(chan struct{}),
		canceled:    make(chan struct{}),
	}
}

func (*blockingSessionUpdateAdapter) Provider() string { return ProviderCodex }

func (*blockingSessionUpdateAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*blockingSessionUpdateAdapter) Resume(context.Context, Session) error { return nil }

func (*blockingSessionUpdateAdapter) Close(context.Context, Session) error { return nil }

func (a *blockingSessionUpdateAdapter) Exec(ctx context.Context, session Session, _ []PromptContentBlock, _ string, _ string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	<-a.readyToEmit
	emit([]activityshared.Event{newSessionTitleActivityEvent(session, "Provider title")})
	close(a.emitted)
	select {
	case <-a.canceled:
		return []activityshared.Event{
			newSessionActivityEvent(session, EventSessionCanceled, SessionStatusCanceled, nil),
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *blockingSessionUpdateAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelOnce.Do(func() {
		close(a.canceled)
	})
	return nil, nil
}
