package agentruntime

import "testing"

// The Codex app-server webSearch item is {id, query, action?}; for a `search`
// action the real query lives in action.query or action.queries[], while the
// top-level `query` is frequently empty. These tests lock in that the daemon
// reads the action so the GUI does not render an empty web-search row.

func TestAppServerWebSearchReadsActionQuery(t *testing.T) {
	item := map[string]any{
		"id":     "ws_1",
		"type":   "webSearch",
		"status": "completed",
		"query":  "",
		"action": map[string]any{"type": "search", "query": "agorax release notes"},
	}

	update, ok := appServerItemToolCallUpdate(item, true)
	if !ok {
		t.Fatalf("expected webSearch item to produce an update")
	}

	rawInput, _ := update["rawInput"].(map[string]any)
	if got := asString(rawInput["query"]); got != "agorax release notes" {
		t.Fatalf("rawInput.query = %q, want %q", got, "agorax release notes")
	}
	action, _ := rawInput["action"].(map[string]any)
	if got := asString(action["query"]); got != "agorax release notes" {
		t.Fatalf("action.query = %q, want %q", got, "agorax release notes")
	}
}

func TestAppServerWebSearchReadsActionQueriesArray(t *testing.T) {
	item := map[string]any{
		"id":     "ws_2",
		"type":   "webSearch",
		"status": "completed",
		"action": map[string]any{
			"type":    "search",
			"queries": []any{"first query", "second query"},
		},
	}

	update, ok := appServerItemToolCallUpdate(item, true)
	if !ok {
		t.Fatalf("expected webSearch item to produce an update")
	}

	rawInput, _ := update["rawInput"].(map[string]any)
	if got := asString(rawInput["query"]); got != "first query" {
		t.Fatalf("rawInput.query = %q, want %q", got, "first query")
	}
	searchQuery, _ := rawInput["search_query"].([]any)
	if len(searchQuery) != 2 {
		t.Fatalf("rawInput.search_query = %#v, want 2 entries", rawInput["search_query"])
	}
}

// The Codex web search streams an empty input on `started` and the real query
// only on `completed`. The completed activity event must carry that input or the
// query is dropped when it merges with the empty started payload.
func TestAcpToolCallEventCompletedCarriesWebSearchInput(t *testing.T) {
	completed := map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "ws_42",
		"kind":          "fetch",
		"status":        "completed",
		"rawInput": map[string]any{
			"query":  "agorax release notes",
			"action": map[string]any{"type": "search", "query": "agorax release notes"},
		},
	}

	session := Session{Provider: "codex", AgentSessionID: "agent-ws", RoomID: "room-ws"}
	event, ok := acpToolCallEventWithID(session, "evt-1", "turn-1", completed)
	if !ok {
		t.Fatalf("expected completed web search update to produce an event")
	}
	if event.Type != EventCallCompleted {
		t.Fatalf("event.Type = %q, want EventCallCompleted", event.Type)
	}
	input, _ := event.Payload.Metadata["input"].(map[string]any)
	if got := asString(input["query"]); got != "agorax release notes" {
		t.Fatalf("completed event input.query = %q, want %q (raw=%#v)", got, "agorax release notes", event.Payload.Metadata["input"])
	}
}

func TestAppServerWebSearchTopLevelQueryFallback(t *testing.T) {
	item := map[string]any{
		"id":    "ws_3",
		"type":  "webSearch",
		"query": "legacy top-level query",
	}

	update, ok := appServerItemToolCallUpdate(item, false)
	if !ok {
		t.Fatalf("expected webSearch item to produce an update")
	}

	rawInput, _ := update["rawInput"].(map[string]any)
	if got := asString(rawInput["query"]); got != "legacy top-level query" {
		t.Fatalf("rawInput.query = %q, want %q", got, "legacy top-level query")
	}
}
