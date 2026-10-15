package agentruntime

import (
	"context"
	"testing"

	agentsessionstore "agorax.local/agent-daemon/packages/agent/daemon/activity"
	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

func TestControllerStateMergesAdapterRuntimeContextWithoutDroppingLaunchContext(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		provider: ProviderCodex,
		snapshot: SessionStateSnapshot{
			RuntimeContext: map[string]any{
				"providerState": "ready",
				"shared":        "provider",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/Users/example/Documents/agorax/session-agent-session-1",
		Title:          "No project session",
		Visible:        true,
		RuntimeContext: map[string]any{
			"noProject": true,
			"shared":    "session",
		},
	}
	controller.store(session)

	snapshot, err := controller.State(session.RoomID, session.AgentSessionID)
	if err != nil {
		t.Fatalf("State() error = %v", err)
	}
	if snapshot.RuntimeContext["noProject"] != true {
		t.Fatalf("runtime context = %#v, want noProject launch marker", snapshot.RuntimeContext)
	}
	if snapshot.RuntimeContext["providerState"] != "ready" {
		t.Fatalf("runtime context = %#v, want provider state", snapshot.RuntimeContext)
	}
	if snapshot.RuntimeContext["shared"] != "provider" {
		t.Fatalf("runtime context shared = %#v, want provider override", snapshot.RuntimeContext["shared"])
	}
}

func TestEnrichReportWithSessionSnapshotPreservesNoProjectLaunchContext(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		provider: ProviderCodex,
		snapshot: SessionStateSnapshot{
			RuntimeContext: map[string]any{"providerState": "ready"},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/Users/example/Documents/agorax/session-agent-session-1",
		RuntimeContext: map[string]any{"noProject": true},
	}
	controller.store(session)
	report := agentsessionstore.ReportActivityInput{WorkspaceID: session.RoomID}

	controller.enrichReportWithSessionSnapshot(session, &report)

	if len(report.StatePatches) != 1 {
		t.Fatalf("state patch count = %d, want 1", len(report.StatePatches))
	}
	if report.StatePatches[0].RuntimeContext["noProject"] != true {
		t.Fatalf("runtime context = %#v, want noProject launch marker", report.StatePatches[0].RuntimeContext)
	}
}

func TestControllerStateRoundTripsSessionSettingsAndPermissionUpdate(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		CWD:            "/workspace",
		Title:          "Codex",
		Settings: &SessionSettings{
			Model:            "gpt-5.2-codex",
			ReasoningEffort:  "high",
			PlanMode:         false,
			PermissionModeID: "full-access",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.Session.Settings == nil {
		t.Fatal("session settings = nil, want round-tripped settings")
	}
	if started.Session.PermissionModeID != "full-access" {
		t.Fatalf("session permission mode = %q, want %q", started.Session.PermissionModeID, "full-access")
	}
	if started.Session.Settings.Model != "gpt-5.2-codex" ||
		started.Session.Settings.ReasoningEffort != "high" ||
		started.Session.Settings.PlanMode ||
		started.Session.Settings.PermissionModeID != "full-access" {
		t.Fatalf("session settings = %#v", started.Session.Settings)
	}

	state, err := controller.State("room-1", "agent-session-1")
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Settings == nil {
		t.Fatal("state settings = nil, want round-tripped settings")
	}
	if state.Settings.Model != "gpt-5.2-codex" ||
		state.Settings.ReasoningEffort != "high" ||
		state.Settings.PlanMode ||
		state.Settings.PermissionModeID != "full-access" {
		t.Fatalf("state settings = %#v", state.Settings)
	}

	updated, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Settings: SessionSettingsPatch{
			PermissionModeID: stringPtr("auto"),
		},
	})
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if updated.Settings.PermissionModeID != "auto" {
		t.Fatalf("updated settings permission mode = %q, want %q", updated.Settings.PermissionModeID, "auto")
	}
	if updated.Settings.Model != "gpt-5.2-codex" ||
		updated.Settings.ReasoningEffort != "high" ||
		updated.Settings.PlanMode {
		t.Fatalf("updated settings = %#v, want launch facts preserved", updated.Settings)
	}

	session, ok := controller.Session("room-1", "agent-session-1")
	if !ok {
		t.Fatal("Session returned ok=false after update")
	}
	if session.PermissionModeID != "auto" {
		t.Fatalf("session permission mode after update = %q, want %q", session.PermissionModeID, "auto")
	}
	if session.Settings == nil || session.Settings.PermissionModeID != "auto" {
		t.Fatalf("session settings after update = %#v", session.Settings)
	}
	if session.Settings.Model != "gpt-5.2-codex" ||
		session.Settings.ReasoningEffort != "high" ||
		session.Settings.PlanMode {
		t.Fatalf("session settings after update = %#v, want launch facts preserved", session.Settings)
	}

	state, err = controller.State("room-1", "agent-session-1")
	if err != nil {
		t.Fatalf("State after update: %v", err)
	}
	if state.PermissionModeID != "auto" {
		t.Fatalf("state permission mode after update = %q, want %q", state.PermissionModeID, "auto")
	}
	if state.Settings == nil || state.Settings.PermissionModeID != "auto" {
		t.Fatalf("state settings after update = %#v", state.Settings)
	}
	if state.Settings.Model != "gpt-5.2-codex" ||
		state.Settings.ReasoningEffort != "high" ||
		state.Settings.PlanMode {
		t.Fatalf("state settings after update = %#v, want launch facts preserved", state.Settings)
	}
}

func TestControllerStateUsesAdapterSnapshot(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		snapshot: SessionStateSnapshot{
			AuthState: "auth_required",
			RuntimeContext: map[string]any{
				"mode": "plan",
			},
			PendingInteractive: &SessionInteractivePrompt{
				Kind:      "ask-user",
				RequestID: "request-1",
			},
		},
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           "room-1",
		AgentSessionID:   "agent-session-1",
		Provider:         ProviderCodex,
		CWD:              "/workspace",
		Title:            "Codex",
		PermissionModeID: "auto",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	snapshot, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if snapshot.AuthState != "auth_required" {
		t.Fatalf("auth state = %q, want auth_required", snapshot.AuthState)
	}
	if snapshot.PendingInteractive == nil || snapshot.PendingInteractive.RequestID != "request-1" {
		t.Fatalf("pending interactive = %#v, want request-1", snapshot.PendingInteractive)
	}
	if got := asString(snapshot.RuntimeContext["mode"]); got != "plan" {
		t.Fatalf("runtime context mode = %q, want plan", got)
	}
}

func TestShouldAdvanceSessionUpdatedAtFromEvents(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	tests := []struct {
		name   string
		events []activityshared.Event
		want   bool
	}{
		{
			name:   "turn started advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, "turn-1", SessionStatusWorking, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn completed advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnCompleted, "turn-1", SessionStatusReady, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn canceled advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnCanceled, "turn-1", SessionStatusCanceled, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn failed advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", nil)},
			want:   true,
		},
		{
			name:   "turn updated does not advance recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", nil)},
			want:   false,
		},
		{
			name:   "turn updated waiting advances recency",
			events: []activityshared.Event{newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", map[string]any{"phase": string(activityshared.TurnPhaseWaitingApproval)})},
			want:   true,
		},
		{
			name:   "session update does not advance recency",
			events: []activityshared.Event{newSessionTitleActivityEvent(session, "Provider title")},
			want:   false,
		},
		{
			name:   "message does not advance recency by itself",
			events: []activityshared.Event{newTurnActivityEvent(session, EventMessage, "turn-1", "", RoleAssistant, "hello", nil)},
			want:   false,
		},
		{
			name:   "tool call does not advance recency by itself",
			events: []activityshared.Event{newTurnActivityEvent(session, EventCallStarted, "turn-1", messageStreamStateStreaming, "", "Read files", nil)},
			want:   false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldAdvanceSessionUpdatedAtFromEvents(tt.events); got != tt.want {
				t.Fatalf("shouldAdvanceSessionUpdatedAtFromEvents() = %v, want %v", got, tt.want)
			}
		})
	}
}
