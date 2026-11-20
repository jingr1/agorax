package agentruntime

import "testing"

func TestSessionCommandsAreScopedAndCloned(t *testing.T) {
	controller := &Controller{commands: map[string]AgentSessionCommandSnapshot{
		sessionKey("workspace-a", "session"): {Commands: []AgentSessionCommand{{Name: "compact"}}},
		sessionKey("workspace-b", "session"): {Commands: []AgentSessionCommand{{Name: "provider-only"}}},
	}}
	commands, ok := controller.SessionCommands("workspace-a", "session")
	if !ok || len(commands) != 1 || commands[0].Name != "compact" {
		t.Fatalf("commands=%v, found=%v", commands, ok)
	}
	commands[0].Name = "mutated"
	again, _ := controller.SessionCommands("workspace-a", "session")
	other, _ := controller.SessionCommands("workspace-b", "session")
	if again[0].Name != "compact" || other[0].Name != "provider-only" {
		t.Fatalf("catalog leaked: current=%v other=%v", again, other)
	}
	if _, ok := controller.SessionCommands("workspace-a", "missing"); ok {
		t.Fatal("missing session returned a command catalog")
	}
}