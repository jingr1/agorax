package agentruntime

import (
	"context"
	"testing"
)

func TestHermesAdapterStartAppliesModelAndReasoningConfigOptions(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Hermes Agent", "hermes-session-1")
	adapter := newHermesExtensionTestAdapter(transport)
	session := standardTestSession(hermesExtensionTestProvider)
	session.Settings = &SessionSettings{
		Model:           "hermes-pro",
		ReasoningEffort: "high",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 2 {
		t.Fatalf("config option calls = %#v, want model + effort", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "model" {
		t.Fatalf("first config id = %q, want model", got)
	}
	if got, _ := calls[0]["value"].(string); got != "hermes-pro" {
		t.Fatalf("first config value = %q, want hermes-pro", got)
	}
	if got, _ := calls[1]["configId"].(string); got != "effort" {
		t.Fatalf("second config id = %q, want effort", got)
	}
	if got, _ := calls[1]["value"].(string); got != "high" {
		t.Fatalf("second config value = %q, want high", got)
	}
}

func TestStandardACPAdapterStartAppliesThoughtLevelConfigOption(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "example-session-1")
	transport.conn.configOptions = []map[string]any{{
		"id":           "thought_level",
		"currentValue": "enabled",
		"options": []any{
			map[string]any{"name": "Enabled", "value": "enabled"},
			map[string]any{"name": "Deep", "value": "deep"},
		},
	}}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:    "acp:example",
		Name:        "example-acp",
		DisplayName: "Example Agent",
		Command:     []string{"example", "--acp"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:example")
	session.Settings = &SessionSettings{ReasoningEffort: "deep"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want thought_level", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "thought_level" {
		t.Fatalf("config id = %q, want thought_level", got)
	}
	if got, _ := calls[0]["value"].(string); got != "deep" {
		t.Fatalf("config value = %q, want deep", got)
	}
	state := adapter.SessionState(session)
	config := payloadObject(state.RuntimeContext["config"])
	if asString(config["reasoning_effort"]) != "deep" {
		t.Fatalf("runtime config = %#v, want canonical reasoning_effort", config)
	}
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	reasoning := configOptionByID(options, "reasoning_effort")
	if reasoning == nil || asString(reasoning["runtimeId"]) != "thought_level" || asString(reasoning["currentValue"]) != "deep" {
		t.Fatalf("runtime configOptions = %#v, want canonical reasoning_effort with runtimeId", options)
	}
}

func TestStandardACPAdapterApplySessionSettingsUsesAdvertisedThoughtLevel(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "example-session-1")
	transport.conn.configOptions = []map[string]any{{
		"id":           "thought_level",
		"currentValue": "enabled",
		"options": []any{
			map[string]any{"name": "Enabled", "value": "enabled"},
			map[string]any{"name": "Deep", "value": "deep"},
		},
	}}
	adapterRaw, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:    "acp:example",
		Name:        "example-acp",
		DisplayName: "Example Agent",
		Command:     []string{"example", "--acp"},
	}, transport, LegacyHostMetadata())
	if err != nil {
		t.Fatalf("NewStandardACPAdapter: %v", err)
	}
	adapter := adapterRaw.(*standardACPAdapter)
	session := standardTestSession("acp:example")

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	session.Settings = &SessionSettings{ReasoningEffort: "deep"}
	if err := adapter.ApplySessionSettings(context.Background(), session, SessionSettingsPatch{
		ReasoningEffort: stringPtr("deep"),
	}); err != nil {
		t.Fatalf("ApplySessionSettings: %v", err)
	}

	calls := transport.conn.setConfigOptionCalls()
	if len(calls) != 1 {
		t.Fatalf("config option calls = %#v, want thought_level", calls)
	}
	if got, _ := calls[0]["configId"].(string); got != "thought_level" {
		t.Fatalf("config id = %q, want thought_level", got)
	}
	if got, _ := calls[0]["value"].(string); got != "deep" {
		t.Fatalf("config value = %q, want deep", got)
	}
}
