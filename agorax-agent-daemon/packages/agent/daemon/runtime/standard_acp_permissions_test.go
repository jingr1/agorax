package agentruntime

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

func TestCursorAdapterStartMapsPermissionTiersToACPModes(t *testing.T) {
	t.Parallel()

	for tier, wantMode := range map[string]string{
		"read-only":   "ask",
		"agent":       "agent",
		"full-access": "agent",
	} {
		transport := newStandardACPTransport("Cursor Agent", "cursor-session-"+tier)
		adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
		session := standardTestSession(ProviderCursor)
		session.PermissionModeID = tier

		if _, err := adapter.Start(context.Background(), session); err != nil {
			t.Fatalf("Start(%s): %v", tier, err)
		}
		if transport.conn.lastModeID() != wantMode {
			t.Fatalf("tier %q mode id = %q, want %q", tier, transport.conn.lastModeID(), wantMode)
		}
	}
}

func TestCursorAdapterStartSkipsSetModeForUnknownMode(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-unknown")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "yolo"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got := transport.conn.lastModeID(); got != "" {
		t.Fatalf("mode id = %q, want no session/set_mode call", got)
	}
}

func TestCursorAdapterNeverSpawnsWithForceFlag(t *testing.T) {
	t.Parallel()

	for _, tier := range []string{"read-only", "agent", "full-access"} {
		transport := newStandardACPTransport("Cursor Agent", "cursor-session-"+tier)
		adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
		session := standardTestSession(ProviderCursor)
		session.PermissionModeID = tier

		if _, err := adapter.Start(context.Background(), session); err != nil {
			t.Fatalf("Start(%s): %v", tier, err)
		}
		// full-access uses live auto-approval, not a spawn flag, so the
		// command is identical across tiers and never needs a respawn.
		if got := strings.Join(transport.specs[0].Command, " "); got != "cursor-agent acp" {
			t.Fatalf("tier %q command = %q, want plain cursor-agent acp", tier, got)
		}
	}
}

func TestCursorAdapterStartUsesPluginDirEnv(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-plugin")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.Env = []string{cursorPluginDirEnv + "=/state/runs/session/cursor-plugin/agorax-cli"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	if got := strings.Join(transport.specs[0].Command, " "); got != "cursor-agent --plugin-dir /state/runs/session/cursor-plugin/agorax-cli acp" {
		t.Fatalf("command = %q, want cursor plugin-dir before acp", got)
	}
}

func TestCursorAdapterFullAccessAutoApprovesWithoutPrompt(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-1")
	transport.conn.promptPermission = true
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "full-access"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-1"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run the build"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish; full-access must auto-approve without waiting for input")
	}

	if got := transport.conn.permissionOptionID(); got != "allow" {
		t.Fatalf("permission option id = %q, want auto-approved allow", got)
	}
	mu.Lock()
	events := ProjectActivityEventsToStreamEvents(session, emittedActivity)
	mu.Unlock()
	if hasStreamCallEvent(events, "approval", "waiting_approval") {
		t.Fatal("full-access must not surface an approval prompt")
	}
}

func TestCursorAdapterAgentTierPromptsForPermission(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-2")
	transport.conn.promptPermission = true
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	session.PermissionModeID = "agent"
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "cursor-session-2"

	var mu sync.Mutex
	var emittedActivity []activityshared.Event
	execDone := make(chan error, 1)
	go func() {
		_, err := adapter.Exec(context.Background(), session, textPrompt("run the build"), "", "turn-1", func(events []activityshared.Event) {
			mu.Lock()
			emittedActivity = append(emittedActivity, events...)
			mu.Unlock()
		}, nil)
		execDone <- err
	}()

	waitForCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		events := ProjectActivityEventsToStreamEvents(session, emittedActivity)
		return hasStreamCallEvent(events, "approval", "waiting_approval")
	})

	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-1",
		RequestID: "permission-1",
		OptionID:  "reject",
	}); err != nil {
		t.Fatalf("SubmitInteractive: %v", err)
	}
	select {
	case err := <-execDone:
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Exec did not finish after permission response")
	}
	if got := transport.conn.permissionOptionID(); got != "reject" {
		t.Fatalf("permission option id = %q, want the user's reject", got)
	}
}

// TestCursorPermissionRequestFallsBackToKnownToolCallInput reproduces a real
// Cursor CLI ACP trace: `session/update` streams a `tool_call` with
// `rawInput.command`, then `session/request_permission` repeats only
// `toolCallId`/`title`/`kind` for that same call (no `rawInput`). Without a
// fallback to the earlier tool_call, the approval card has no command detail
// to show — only the title and options.
func TestCursorPermissionRequestFallsBackToKnownToolCallInput(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-fallback")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()

	started := standardACPUpdateEvents(standardACPConfig{provider: ProviderCursor}, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "toolu_bdrk_01Q5tgfQbZyrAVBAUp71Eq8A",
			"title": "`+"`echo hello-from-permission-probe`"+`",
			"kind": "execute",
			"status": "pending",
			"rawInput": {"command": "echo hello-from-permission-probe"}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want one call.started", started)
	}

	events, pending, err := standardACPPermissionRequested(adapter, session, "turn-1", json.RawMessage(`2`), json.RawMessage(`{
		"toolCall": {
			"toolCallId": "toolu_bdrk_01Q5tgfQbZyrAVBAUp71Eq8A",
			"title": "`+"`echo hello-from-permission-probe`"+`",
			"kind": "execute",
			"status": "pending",
			"content": [{"type": "content", "content": {"type": "text", "text": "Not in allowlist: echo"}}]
		},
		"options": [
			{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatalf("standardACPPermissionRequested: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("events = empty, want at least the waiting-approval turn event")
	}
	if pending == nil {
		t.Fatal("pending = nil, want a stored pending approval")
	}
	if got := asString(pending.input["command"]); got != "echo hello-from-permission-probe" {
		t.Fatalf("pending.input[command] = %q, want the command captured from the earlier tool_call", got)
	}
}

func TestACPPermissionRequestFallsBackToKnownFileChanges(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-file-changes")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()
	config := standardACPConfig{provider: ProviderCursor}

	started := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": "file-change-1",
			"title": "Apply file changes",
			"kind": "edit",
			"status": "pending",
			"rawInput": {
				"changes": [
					{"path": "/workspace/src/app.ts", "kind": {"type": "update"}},
					{"path": "/workspace/src/game.ts", "kind": {"type": "create"}}
				]
			}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want one call.started", started)
	}

	updated := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": "file-change-1",
			"title": "Apply file changes",
			"kind": "edit",
			"status": "pending"
		}
	}`), normalizer)
	if len(updated) == 0 {
		t.Fatal("empty tool-call update was not projected")
	}

	events, pending, err := standardACPPermissionRequested(adapter, session, "turn-1", json.RawMessage(`3`), json.RawMessage(`{
		"toolCall": {
			"toolCallId": "file-change-1",
			"title": "Apply file changes",
			"kind": "edit",
			"status": "pending"
		},
		"options": [
			{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatalf("standardACPPermissionRequested: %v", err)
	}
	if pending == nil {
		t.Fatal("pending approval is nil")
	}
	if pending.approvalPurpose != approvalPurposeEditFiles {
		t.Fatalf("pending approval purpose = %q, want %q", pending.approvalPurpose, approvalPurposeEditFiles)
	}
	interaction := events[len(events)-1].Payload.Interaction
	if interaction == nil || asString(interaction.Metadata["approvalPurpose"]) != approvalPurposeEditFiles {
		t.Fatalf("interaction approval purpose = %#v, want %q", interaction, approvalPurposeEditFiles)
	}
	changes, ok := pending.input["changes"].([]any)
	if !ok || len(changes) != 2 {
		t.Fatalf("pending approval changes = %#v, want both known file changes", pending.input["changes"])
	}
}

// TestCursorPermissionRequestKeepsKnownInputAfterEmptyToolCallUpdate reproduces
// the live Cursor sequence behind blank approval cards: tool_call carries
// rawInput.command, a later tool_call_update for the same id repeats only
// title/kind/status/content (no rawInput), then session/request_permission
// also omits rawInput. The empty update must not wipe the pending snapshot, or
// KnownToolCallInput has nothing left to backfill onto the approval card.
func TestCursorPermissionRequestKeepsKnownInputAfterEmptyToolCallUpdate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Cursor Agent", "cursor-session-empty-update")
	adapter := newCursorAdapterWithHostMetadata(transport, LegacyHostMetadata(), nil)
	session := standardTestSession(ProviderCursor)
	normalizer := newACPTurnNormalizer()
	config := standardACPConfig{provider: ProviderCursor}
	toolCallID := "call-4341cda2-656d-41c2-8ec3-80f0b3b6d09a-0\nfc_918c4886-f213-9396-8439-d721f380bc12_0"
	command := `echo "hello from bash" && pwd && date`

	started := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call",
			"toolCallId": `+jsonString(toolCallID)+`,
			"title": `+jsonString("`"+command+"`")+`,
			"kind": "execute",
			"status": "pending",
			"rawInput": {"command": `+jsonString(command)+`}
		}
	}`), normalizer)
	if len(started) != 1 || started[0].Type != activityshared.EventCallStarted {
		t.Fatalf("started events = %#v, want one call.started", started)
	}
	if got := asString(payloadMap(started[0].Payload.Metadata, "input")["command"]); got != command {
		t.Fatalf("started input.command = %q, want %q", got, command)
	}

	updated := standardACPUpdateEvents(config, session, "turn-1", json.RawMessage(`{
		"update": {
			"sessionUpdate": "tool_call_update",
			"toolCallId": `+jsonString(toolCallID)+`,
			"title": `+jsonString("`"+command+"`")+`,
			"kind": "execute",
			"status": "pending",
			"content": [{"type": "content", "content": {"type": "text", "text": "Not in allowlist: echo"}}]
		}
	}`), normalizer)
	if len(updated) == 0 {
		t.Fatal("updated events = empty, want the tool_call_update projection")
	}
	if got := normalizer.KnownToolCallInput(toolCallID); asString(got["command"]) != command {
		t.Fatalf("KnownToolCallInput after empty update = %#v, want command %q preserved", got, command)
	}

	_, pending, err := standardACPPermissionRequested(adapter, session, "turn-1", json.RawMessage(`0`), json.RawMessage(`{
		"toolCall": {
			"toolCallId": `+jsonString(toolCallID)+`,
			"title": `+jsonString("`"+command+"`")+`,
			"kind": "execute",
			"status": "pending",
			"content": [{"type": "content", "content": {"type": "text", "text": "Not in allowlist: echo"}}]
		},
		"options": [
			{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
			{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
			{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatalf("standardACPPermissionRequested: %v", err)
	}
	if pending == nil {
		t.Fatal("pending = nil, want a stored pending approval")
	}
	if got := asString(pending.input["command"]); got != command {
		t.Fatalf("pending.input[command] = %q, want command preserved across empty tool_call_update", got)
	}
}

func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestCursorAutoApprovePermissionDecision(t *testing.T) {
	t.Parallel()

	if got := cursorAutoApprovePermissionDecision("full-access"); got != "approved" {
		t.Fatalf("full-access decision = %q, want approved", got)
	}
	for _, tier := range []string{"agent", "read-only", "", "yolo"} {
		if got := cursorAutoApprovePermissionDecision(tier); got != "" {
			t.Fatalf("tier %q decision = %q, want prompt (empty)", tier, got)
		}
	}
}

func TestResolveACPPermissionDecisionOptionID(t *testing.T) {
	t.Parallel()

	options := []map[string]any{
		{"optionId": "allow-once", "name": "Allow once"},
		{"optionId": "allow-always", "name": "Allow always"},
		{"optionId": "reject-once", "name": "Reject"},
	}
	if got, ok := resolveACPPermissionDecisionOptionID(options, "approved"); !ok || got != "allow-once" {
		t.Fatalf("approved -> %q (ok=%v), want allow-once", got, ok)
	}
	if got, ok := resolveACPPermissionDecisionOptionID(options, "denied"); !ok || got != "reject-once" {
		t.Fatalf("denied -> %q (ok=%v), want reject-once", got, ok)
	}
	if _, ok := resolveACPPermissionDecisionOptionID(nil, "approved"); ok {
		t.Fatal("no options must not resolve")
	}
}

func TestNormalizedApprovalDisplayInputHarvestsContentJSON(t *testing.T) {
	t.Parallel()
	got := normalizedApprovalDisplayInput(map[string]any{
		"toolCallId": "6:bash",
		"title":      "Bash",
		"content": []any{
			map[string]any{
				"type": "content",
				"content": map[string]any{
					"type": "text",
					"text": `{"command": "pwd"}`,
				},
			},
		},
	}, nil)
	if asString(got["command"]) != "pwd" {
		t.Fatalf("display input = %#v, want command pwd", got)
	}
}

func TestOrdinaryApprovalPublishesInteractionImmediatelyWithoutToolInput(t *testing.T) {
	t.Parallel()
	transport := newStandardACPTransport("Kimi Code", "kimi-session-empty-input")
	adapter := newKimiCodeExtensionTestAdapter(t, transport)
	session := standardTestSession("acp:kimi-code")
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	session.ProviderSessionID = "kimi-session-empty-input"
	normalizer := newACPTurnNormalizer()
	events, pending, err := standardACPPermissionRequested(adapter, session, "turn-empty", json.RawMessage(`"0"`), json.RawMessage(`{
		"toolCall": {"toolCallId": "6:bash", "title": "Bash"},
		"options": [
			{"optionId": "approve_once", "name": "Approve once", "kind": "allow_once"},
			{"optionId": "reject", "name": "Reject", "kind": "reject_once"}
		]
	}`), normalizer)
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil || !pending.interactionRequested {
		t.Fatalf("pending = %#v, want immediately published approval", pending)
	}
	requested := eventsOfType(events, activityshared.EventInteractionRequested)
	if len(requested) != 1 {
		t.Fatalf("permission events = %#v, want one interaction.requested", events)
	}
}
