package agentruntime

import (
	"context"
	"errors"
	"testing"
)

func TestControllerSetTitleUpdatesLiveSession(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	controller.store(Session{
		RoomID:          "room-1",
		AgentSessionID:  "agent-session-1",
		Provider:        ProviderCodex,
		CWD:             "/workspace",
		Status:          SessionStatusReady,
		Title:           "Old title",
		UpdatedAtUnixMS: 10,
	})

	session, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", "  New title  ")
	if err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	if session.Title != "New title" {
		t.Fatalf("returned title = %q, want trimmed title", session.Title)
	}
	if session.UpdatedAtUnixMS <= 10 {
		t.Fatalf("returned updatedAt = %d, want later than previous timestamp", session.UpdatedAtUnixMS)
	}
	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("session missing after SetTitle")
	}
	if stored.Title != "New title" {
		t.Fatalf("stored title = %q, want new title", stored.Title)
	}
	if _, err := controller.SetTitle(context.Background(), "room-1", "missing-session", "Title"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing session error = %v, want ErrSessionNotFound", err)
	}
}

func TestControllerExecInitialTitleCompareAndSetPreservesRename(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&recordingStartAdapter{provider: ProviderCodex}}, nil)
	_, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", "Manual title"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Content:          textPrompt("hello"),
		InitialTitle:     "hello",
		InitialTitleBase: "",
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	session, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("session missing after Exec")
	}
	if session.Title != "Manual title" {
		t.Fatalf("session title = %q, want concurrent rename preserved", session.Title)
	}
}

func TestControllerInitialTitleStateSurvivesResume(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.InitialTitleEstablished {
		t.Fatal("new empty session title unexpectedly established")
	}
	if established := started.Session.RuntimeContext[initialTitleEstablishedRuntimeContextKey]; established != false {
		t.Fatalf("runtime title marker = %#v, want false", established)
	}
	reporter.waitForCalls(t, 1)
	if _, err := controller.SetTitle(context.Background(), "room-1", "agent-session-1", ""); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	persisted, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("session missing after SetTitle")
	}
	if persisted.RuntimeContext[initialTitleEstablishedRuntimeContextKey] != true {
		t.Fatalf("runtime title marker = %#v, want true", persisted.RuntimeContext)
	}
	reports := reporter.waitForCalls(t, 2)
	lastReport := reports[len(reports)-1].report
	if len(lastReport.StatePatches) != 1 ||
		lastReport.StatePatches[0].RuntimeContext[initialTitleEstablishedRuntimeContextKey] != true {
		t.Fatalf("persisted title marker report = %#v, want true", lastReport.StatePatches)
	}

	resumedController := NewController([]Adapter{adapter}, nil)
	resumed, err := resumedController.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		CWD:               "/workspace",
		RuntimeContext:    persisted.RuntimeContext,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !resumed.InitialTitleEstablished {
		t.Fatal("resumed empty title lost established state")
	}
	if _, err := resumedController.Exec(context.Background(), ExecInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Content:          textPrompt("later prompt"),
		InitialTitle:     "later prompt",
		InitialTitleBase: "",
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	current, _ := resumedController.get("room-1", "agent-session-1")
	if current.Title != "" {
		t.Fatalf("resumed session title = %q, want explicit empty title preserved", current.Title)
	}
}

func TestInitialTitleEstablishedStateFailsClosedWithoutMarker(t *testing.T) {
	t.Parallel()

	if !initialTitleEstablishedFromRuntimeContext(nil, "") {
		t.Fatal("legacy empty session without marker must fail closed")
	}
	if initialTitleEstablishedFromRuntimeContext(
		map[string]any{initialTitleEstablishedRuntimeContextKey: false},
		"",
	) {
		t.Fatal("new empty session with false marker must remain eligible")
	}

	controller := NewController(
		[]Adapter{&recordingStartAdapter{provider: ProviderCodex}},
		nil,
	)
	resumed, err := controller.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "legacy-session",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if resumed.RuntimeContext[initialTitleEstablishedRuntimeContextKey] != true {
		t.Fatalf("legacy resume marker = %#v, want true", resumed.RuntimeContext)
	}
}
