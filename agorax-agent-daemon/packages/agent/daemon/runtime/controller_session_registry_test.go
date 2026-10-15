package agentruntime

import (
	"context"
	"testing"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

type commandEmittingAdapter struct {
	statefulInteractiveAdapter
}

func (*commandEmittingAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, _ string, _ EventSink, emitCommands CommandSnapshotSink) ([]activityshared.Event, error) {
	if emitCommands != nil {
		emitCommands(AgentSessionCommandSnapshot{
			AgentSessionID: session.AgentSessionID,
			Commands: []AgentSessionCommand{{
				Name:        "web",
				Description: "Search the web",
				InputHint:   "query",
			}},
		})
	}
	return nil, nil
}

func TestControllerPublishesAndReplaysCommandSnapshots(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{
		commandSnapshot: AgentSessionCommandSnapshot{
			AgentSessionID: "agent-session-1",
			Commands: []AgentSessionCommand{{
				Name:        "init",
				Description: "Initial command",
				InputHint:   "value",
			}},
		},
		hasCommands: true,
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	event := waitForStreamEventType(t, events, StreamEventAvailableCommands)
	snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "init" {
		t.Fatalf("replayed command event = %#v, want initial command snapshot", event)
	}

	liveAdapter := &commandEmittingAdapter{}
	liveController := NewController([]Adapter{liveAdapter}, nil)
	started, err = liveController.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-2",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start live: %v", err)
	}
	liveEvents, liveUnsubscribe, ok := liveController.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe live returned ok=false")
	}
	defer liveUnsubscribe()
	if _, err := liveController.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	}); err != nil {
		t.Fatalf("Exec live: %v", err)
	}
	event = waitForStreamEventType(t, liveEvents, StreamEventAvailableCommands)
	snapshot, ok = event.Data.(AgentSessionCommandSnapshot)
	if !ok || len(snapshot.Commands) != 1 || snapshot.Commands[0].Name != "web" {
		t.Fatalf("live command event = %#v, want web command snapshot", event)
	}

	if _, err := liveController.Close(context.Background(), CloseInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close live: %v", err)
	}
	if _, _, ok := liveController.Subscribe("room-1", started.Session.AgentSessionID); ok {
		t.Fatal("Subscribe after close returned ok=true")
	}
}

func TestControllerReplaysCommandSnapshotsQueuedBeforeStartRegistration(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	if adapter.commandSink == nil {
		t.Fatal("adapter command snapshot sink was not installed")
	}
	adapter.commandSink(AgentSessionCommandSnapshot{
		AgentSessionID: "agent-session-1",
		Commands: []AgentSessionCommand{{
			Name:        "compact",
			Description: "Compact context",
		}},
	})

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	event := waitForStreamEventType(t, events, StreamEventAvailableCommands)
	snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
	if !ok || snapshot.AgentSessionID != "agent-session-1" ||
		len(snapshot.Commands) != 1 ||
		snapshot.Commands[0].Name != "compact" {
		t.Fatalf("replayed command event = %#v, want queued compact command snapshot", event)
	}
}

func TestControllerReplaysCommandSnapshotsQueuedBeforeResumeRegistration(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	if adapter.commandSink == nil {
		t.Fatal("adapter command snapshot sink was not installed")
	}
	adapter.commandSink(AgentSessionCommandSnapshot{
		AgentSessionID: "agent-session-1",
		Commands: []AgentSessionCommand{{
			Name:        "plan",
			Description: "Enter plan mode",
		}},
	})

	resumed, err := controller.Resume(context.Background(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "agent-session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		Title:             "Test",
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", resumed.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	event := waitForStreamEventType(t, events, StreamEventAvailableCommands)
	snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
	if !ok || snapshot.AgentSessionID != "agent-session-1" ||
		len(snapshot.Commands) != 1 ||
		snapshot.Commands[0].Name != "plan" {
		t.Fatalf("replayed command event = %#v, want queued plan command snapshot", event)
	}
}

func TestControllerPublishesConfigOptionsUpdatesFromAdapterSink(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if adapter.configSink == nil {
		t.Fatal("adapter config options update sink was not installed")
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	adapter.configSink(AgentSessionConfigOptionsUpdate{
		AgentSessionID:  started.Session.AgentSessionID,
		ConfigOptionKey: "model",
	})
	event := waitForStreamEventType(t, events, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("config options stream event data = %#v, want update payload", event.Data)
	}
	if update.AgentSessionID != started.Session.AgentSessionID ||
		update.Provider != ProviderCodex ||
		update.ProviderSessionID != started.Session.ProviderSessionID ||
		update.ConfigOptionKey != "model" ||
		update.OccurredAtUnixMS <= 0 {
		t.Fatalf("config options update = %#v, want populated payload", update)
	}
}

func TestControllerReplaysConfigOptionsUpdatesQueuedBeforeSessionRegistration(t *testing.T) {
	t.Parallel()

	adapter := &statefulInteractiveAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	if adapter.configSink == nil {
		t.Fatal("adapter config options update sink was not installed")
	}
	adapter.configSink(AgentSessionConfigOptionsUpdate{
		RoomID:          "room-1",
		AgentSessionID:  "agent-session-1",
		ConfigOptionKey: "model",
	})

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()

	event := waitForStreamEventType(t, events, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("config options stream event data = %#v, want update payload", event.Data)
	}
	if update.RoomID != "room-1" ||
		update.AgentSessionID != "agent-session-1" ||
		update.Provider != ProviderCodex ||
		update.ConfigOptionKey != "model" {
		t.Fatalf("config options update = %#v, want replayed model update", update)
	}
}
