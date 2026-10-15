package agentruntime

import (
	"context"
	"strings"
	"testing"
	"time"

	agentsessionstore "agorax.local/agent-daemon/packages/agent/daemon/activity"
)

func TestControllerUpdateSettingsAppliesOpenProviderPermissionMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "example-session-1")
	transport.conn.configOptions = []map[string]any{{
		"id":           "mode",
		"currentValue": "default",
		"options": []any{
			map[string]any{"name": "Default", "value": "default"},
			map[string]any{"name": "Automatic", "value": "auto"},
		},
	}}
	adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:    "acp:example",
		Name:        "example-acp",
		DisplayName: "Example Agent",
		Command:     []string{"example", "--acp"},
		PermissionModes: map[string]string{
			"default": "default",
			"auto":    "auto",
		},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       "acp:example",
		CWD:            "/workspace",
		Title:          "Example Agent",
		Settings: &SessionSettings{
			PermissionModeID: "default",
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	updated, err := controller.UpdateSettings(context.Background(), UpdateSettingsInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Settings: SessionSettingsPatch{
			PermissionModeID: stringPtr("auto"),
		},
	})
	if err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if updated.Settings.PermissionModeID != "auto" {
		t.Fatalf("updated permission mode = %q, want auto", updated.Settings.PermissionModeID)
	}
	session, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false")
	}
	if session.PermissionModeID != "auto" {
		t.Fatalf("session permission mode = %q, want auto", session.PermissionModeID)
	}
	if transport.conn.lastModeID() != "auto" {
		t.Fatalf("mode id = %q, want auto", transport.conn.lastModeID())
	}
}

//nolint:unused // Retain the migrated config-option fixture for focused controller tests.
func configOptionDescriptorValues(descriptors []map[string]any, configID string) []string {
	for _, descriptor := range descriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		switch options := descriptor["options"].(type) {
		case []any:
			values := make([]string, 0, len(options))
			for _, option := range options {
				record, ok := option.(map[string]any)
				if !ok {
					continue
				}
				if value := strings.TrimSpace(asString(record["value"])); value != "" {
					values = append(values, value)
				}
			}
			return values
		case []map[string]any:
			values := make([]string, 0, len(options))
			for _, option := range options {
				if value := strings.TrimSpace(asString(option["value"])); value != "" {
					values = append(values, value)
				}
			}
			return values
		default:
			return nil
		}
	}
	return nil
}

//nolint:unused // Retain the migrated config-option fixture for focused controller tests.
func configOptionDescriptorOptionDescription(descriptors []map[string]any, configID string, value string) string {
	for _, descriptor := range descriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != configID {
			continue
		}
		switch options := descriptor["options"].(type) {
		case []any:
			for _, option := range options {
				record, ok := option.(map[string]any)
				if !ok {
					continue
				}
				if strings.TrimSpace(asString(record["value"])) == value {
					return strings.TrimSpace(asString(record["description"]))
				}
			}
		case []map[string]any:
			for _, option := range options {
				if strings.TrimSpace(asString(option["value"])) == value {
					return strings.TrimSpace(asString(option["description"]))
				}
			}
		}
	}
	return ""
}

func TestControllerPublishesIdleStandardACPCommandUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-idle-commands")
	adapter := newOpenCodeTestAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderOpenCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendAvailableCommandsUpdate()

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventAvailableCommands {
				continue
			}
			snapshot, ok := event.Data.(AgentSessionCommandSnapshot)
			if !ok {
				t.Fatalf("event data = %#v, want AgentSessionCommandSnapshot", event.Data)
			}
			if len(snapshot.Commands) == 1 && snapshot.Commands[0].Name == "web" {
				return
			}
		case <-deadline:
			t.Fatal("idle available_commands_update was not published")
		}
	}
}

func TestControllerPublishesIdleStandardACPGoalUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-idle-goal")
	adapter := newOpenCodeTestAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderOpenCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": transport.conn.sessionID,
			"update": map[string]any{
				"sessionUpdate": "thread_goal_update",
				"goal": map[string]any{
					"objective": "ship slash commands",
					"status":    "active",
				},
			},
		},
	})

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventStatePatch {
				continue
			}
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want WorkspaceAgentStatePatch", event.Data)
			}
			goal := payloadObject(patch.RuntimeContext["goal"])
			if asString(goal["objective"]) == "ship slash commands" {
				return
			}
		case <-deadline:
			t.Fatal("idle thread_goal_update was not published")
		}
	}
}

func TestControllerSyncCursorPlanModeFromACPUpdate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-plan-sync")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"
	session.Settings = &SessionSettings{
		PermissionModeID: "agent",
		PlanMode:         false,
	}

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
		Settings:         session.Settings,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendJSON(map[string]any{
		"jsonrpc": "2.0",
		"method":  acpMethodUpdate,
		"params": map[string]any{
			"sessionId": transport.conn.sessionID,
			"update": map[string]any{
				"sessionUpdate": "current_mode_update",
				"currentModeId": "plan",
			},
		},
	})

	deadline := time.After(time.Second)
	for {
		select {
		case event := <-stream:
			if event.EventType != StreamEventStatePatch {
				continue
			}
			patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
			if !ok {
				t.Fatalf("event data = %#v, want WorkspaceAgentStatePatch", event.Data)
			}
			if patch.Settings != nil && patch.Settings["planMode"] == true {
				stored, ok := controller.get(started.Session.RoomID, started.Session.AgentSessionID)
				if !ok || stored.Settings == nil || !stored.Settings.PlanMode {
					t.Fatalf("stored session settings = %#v, want planMode true", stored.Settings)
				}
				if stored.PermissionModeID != "agent" {
					t.Fatalf("permission mode = %q, want unchanged agent", stored.PermissionModeID)
				}
				return
			}
		case <-deadline:
			t.Fatal("cursor current_mode_update did not publish planMode state patch")
		}
	}
}

func TestControllerPublishesIdleStandardACPConfigOptionsUpdatesAfterStart(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("OpenCode", "opencode-session-idle-config-options")
	adapter := newOpenCodeTestAdapter(transport)
	controller := NewController([]Adapter{adapter}, nil)
	session := standardTestSession(ProviderOpenCode)

	started, err := controller.Start(context.Background(), StartInput{
		RoomID:           session.RoomID,
		AgentSessionID:   session.AgentSessionID,
		Provider:         session.Provider,
		CWD:              session.CWD,
		PermissionModeID: session.PermissionModeID,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	stream, unsubscribe, ok := controller.Subscribe(started.Session.RoomID, started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe ok=false, want live session stream")
	}
	defer unsubscribe()

	transport.conn.sendConfigOptionsUpdate("model", "opus")

	event := waitForStreamEventType(t, stream, StreamEventConfigOptions)
	update, ok := event.Data.(AgentSessionConfigOptionsUpdate)
	if !ok {
		t.Fatalf("event data = %#v, want AgentSessionConfigOptionsUpdate", event.Data)
	}
	if update.AgentSessionID != started.Session.AgentSessionID || update.ConfigOptionKey != "model" {
		t.Fatalf("config options update = %#v, want model update for session", update)
	}
}
