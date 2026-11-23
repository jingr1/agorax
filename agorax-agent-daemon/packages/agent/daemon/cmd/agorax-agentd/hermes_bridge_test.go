package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

func TestHermesBridgeActivityWritesStrongIds(t *testing.T) {
	t.Parallel()
	dbPath := filepath.Join(t.TempDir(), "agent.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	body, _ := json.Marshal(hermesBridgeActivityRequest{
		ProviderSessionID: "gw-sess-1",
		TurnID:            "turn-submit-1",
		Phase:             storesqlite.TurnPhaseSettled,
		Outcome:           storesqlite.TurnOutcomeCompleted,
		Messages: []hermesBridgeMessage{
			{
				MessageID: "user:submit-1",
				TurnID:    "turn-submit-1",
				Role:      "user",
				Kind:      "text",
				Status:    "completed",
				Payload:   map[string]any{"text": "继续", "clientSubmitId": "submit-1"},
			},
			{
				MessageID: "assistant:run-1",
				TurnID:    "turn-submit-1",
				Role:      "assistant",
				Kind:      "text",
				Status:    "completed",
				Payload:   map[string]any{"text": "收到", "runId": "run-1"},
			},
		},
	})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/workspaces/hermes:default/hermes-bridge/sessions/gw-sess-1/activity",
		bytes.NewReader(body),
	)
	req.SetPathValue("workspaceID", "hermes:default")
	req.SetPathValue("agentSessionID", "gw-sess-1")
	rr := httptest.NewRecorder()
	handleHermesBridgeActivity(store)(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rr.Code, rr.Body.String())
	}

	page, ok, err := store.ListSessionMessages(context.Background(), storesqlite.ListSessionMessagesInput{
		WorkspaceID:    "hermes:default",
		AgentSessionID: "gw-sess-1",
		Limit:          20,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages ok=%v err=%v", ok, err)
	}
	if len(page.Messages) != 2 {
		t.Fatalf("messages = %#v, want 2 strong-id rows", page.Messages)
	}
	if page.Messages[0].MessageID != "user:submit-1" || page.Messages[1].MessageID != "assistant:run-1" {
		t.Fatalf("message ids = %q %q", page.Messages[0].MessageID, page.Messages[1].MessageID)
	}
}
