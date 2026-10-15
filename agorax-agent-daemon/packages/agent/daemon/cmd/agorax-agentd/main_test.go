package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agorax.local/agent-daemon/packages/agent/daemon/liveprotocol"
	agentruntime "agorax.local/agent-daemon/packages/agent/daemon/runtime"
	agenthost "agorax.local/agent-daemon/packages/agent/host"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
	canonical "agorax.local/agent-daemon/packages/agent/store-sqlite/canonical"
	_ "modernc.org/sqlite"
)

// hubFrames collects published WS frames for assertions.
func hubFrames(hub *eventHub) (chan map[string]any, func()) {
	channel, unsubscribe := hub.subscribe()
	frames := make(chan map[string]any, 64)
	go func() {
		for payload := range channel {
			var frame struct {
				Kind  string          `json:"kind"`
				Event json.RawMessage `json:"event"`
			}
			if err := json.Unmarshal(payload, &frame); err != nil || frame.Kind != "event" {
				continue
			}
			var envelope map[string]any
			if err := json.Unmarshal(frame.Event, &envelope); err != nil {
				continue
			}
			frames <- envelope
		}
		close(frames)
	}()
	return frames, unsubscribe
}

func nextEnvelope(t *testing.T, frames chan map[string]any) map[string]any {
	t.Helper()
	select {
	case envelope, ok := <-frames:
		if !ok {
			t.Fatal("hub closed before next frame")
		}
		return envelope
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for hub frame")
		return nil
	}
}

func TestPublishActivityEmitsAgoraxEnvelope(t *testing.T) {
	hub := newEventHub()
	frames, unsubscribe := hubFrames(hub)
	defer unsubscribe()

	hub.publishActivity("workspace-1", "session-1", activityEventTurnUpdate, map[string]any{
		"occurredAtUnixMs": int64(42),
	})
	hub.publishActivity("workspace-1", "session-1", activityEventSessionReconcileRequired, map[string]any{
		"lastEventUnixMs": int64(43),
	})

	first := nextEnvelope(t, frames)
	second := nextEnvelope(t, frames)

	for index, envelope := range []map[string]any{first, second} {
		id, _ := envelope["id"].(string)
		if len(id) != 36 || strings.Count(id, "-") != 4 {
			t.Fatalf("envelope %d id %q is not UUID-shaped", index, id)
		}
		if envelope["topic"] != agentActivityUpdatedTopic {
			t.Fatalf("envelope %d topic = %v", index, envelope["topic"])
		}
		if envelope["emittedAt"].(float64) <= 0 {
			t.Fatalf("envelope %d emittedAt = %v", index, envelope["emittedAt"])
		}
		scope, ok := envelope["scope"].(map[string]any)
		if !ok || scope["workspaceId"] != "workspace-1" {
			t.Fatalf("envelope %d scope = %v", index, envelope["scope"])
		}
		payload, ok := envelope["payload"].(map[string]any)
		if !ok {
			t.Fatalf("envelope %d payload missing", index)
		}
		if payload["workspaceId"] != "workspace-1" || payload["agentSessionId"] != "session-1" {
			t.Fatalf("envelope %d payload identity = %v", index, payload)
		}
		data, ok := payload["data"].(map[string]any)
		if !ok {
			t.Fatalf("envelope %d data missing", index)
		}
		if data["workspaceId"] != "workspace-1" || data["agentSessionId"] != "session-1" {
			t.Fatalf("envelope %d data identity = %v", index, data)
		}
	}
	if first["version"].(float64) != 1 || second["version"].(float64) != 2 {
		t.Fatalf("envelope versions = %v, %v, want monotonic 1, 2", first["version"], second["version"])
	}
	if first["payload"].(map[string]any)["eventType"] != activityEventTurnUpdate {
		t.Fatalf("first payload eventType = %v", first["payload"].(map[string]any)["eventType"])
	}
	if second["payload"].(map[string]any)["eventType"] != activityEventSessionReconcileRequired {
		t.Fatalf("second payload eventType = %v", second["payload"].(map[string]any)["eventType"])
	}
	if second["payload"].(map[string]any)["data"].(map[string]any)["lastEventUnixMs"].(float64) != 43 {
		t.Fatalf("reconcile data = %v", second["payload"].(map[string]any)["data"])
	}
}

func TestBridgePublishesFullMessageDeltaPayload(t *testing.T) {
	hub := newEventHub()
	frames, unsubscribe := hubFrames(hub)
	defer unsubscribe()
	bridge := &agentActivityEventBridge{hub: hub}

	offset := int64(7)
	delta, err := liveprotocol.NewMessageDeltaEvent(liveprotocol.MessageDeltaData{
		WorkspaceID:      "workspace-1",
		AgentSessionID:   "session-1",
		MessageID:        "toolcall:call-1",
		TurnID:           "turn-1",
		Role:             "assistant",
		Kind:             "tool_call",
		OccurredAtUnixMS: 99,
		ToolOutput:       &liveprotocol.MessageToolOutputOperation{Operation: "append_text", Text: "file listing", OffsetBytes: &offset},
		PayloadSet:       map[string]json.RawMessage{"status": json.RawMessage(`"running"`)},
	})
	if err != nil {
		t.Fatalf("NewMessageDeltaEvent: %v", err)
	}
	if err := bridge.ObserveRuntimeStreamEvents(context.Background(), "workspace-1", "session-1",
		[]agentruntime.StreamEvent{{EventType: agentruntime.StreamEventMessageDelta, Data: delta}}); err != nil {
		t.Fatalf("ObserveRuntimeStreamEvents: %v", err)
	}

	envelope := nextEnvelope(t, frames)
	payload := envelope["payload"].(map[string]any)
	if payload["eventType"] != activityEventMessageDelta {
		t.Fatalf("eventType = %v", payload["eventType"])
	}
	data := payload["data"].(map[string]any)
	if data["messageId"] != "toolcall:call-1" || data["turnId"] != "turn-1" {
		t.Fatalf("delta identity = %v", data)
	}
	toolOutput, ok := data["toolOutput"].(map[string]any)
	if !ok || toolOutput["text"] != "file listing" || toolOutput["offsetBytes"].(float64) != 7 {
		t.Fatalf("toolOutput = %v", data["toolOutput"])
	}
	payloadSet, ok := data["payloadSet"].(map[string]any)
	if !ok || payloadSet["status"] != "running" {
		t.Fatalf("payloadSet = %v", data["payloadSet"])
	}
}

func TestBridgePublishesReconcileRequiredForMalformedDelta(t *testing.T) {
	hub := newEventHub()
	frames, unsubscribe := hubFrames(hub)
	defer unsubscribe()
	bridge := &agentActivityEventBridge{hub: hub}

	err := bridge.ObserveRuntimeStreamEvents(context.Background(), "workspace-1", "session-1",
		[]agentruntime.StreamEvent{{EventType: agentruntime.StreamEventMessageDelta, Data: "not-an-event"}})
	if err == nil {
		t.Fatal("ObserveRuntimeStreams error = nil, want malformed delta error")
	}
	envelope := nextEnvelope(t, frames)
	payload := envelope["payload"].(map[string]any)
	if payload["eventType"] != activityEventSessionReconcileRequired {
		t.Fatalf("eventType = %v, want session_reconcile_required", payload["eventType"])
	}
	data := payload["data"].(map[string]any)
	if data["lastEventUnixMs"].(float64) <= 0 {
		t.Fatalf("lastEventUnixMs = %v", data["lastEventUnixMs"])
	}
}

func TestBridgePublishesReconcileRequiredForCrossScopeDelta(t *testing.T) {
	hub := newEventHub()
	frames, unsubscribe := hubFrames(hub)
	defer unsubscribe()
	bridge := &agentActivityEventBridge{hub: hub}

	delta, err := liveprotocol.NewMessageDeltaEvent(liveprotocol.MessageDeltaData{
		WorkspaceID: "workspace-other", AgentSessionID: "session-1",
		MessageID: "m-1", TurnID: "turn-1", Role: "assistant", Kind: "text",
		OccurredAtUnixMS: 99, Content: &liveprotocol.MessageContentOperation{Operation: "append_text", Text: "hi"},
	})
	if err != nil {
		t.Fatalf("NewMessageDeltaEvent: %v", err)
	}
	if err := bridge.ObserveRuntimeStreamEvents(context.Background(), "workspace-1", "session-1",
		[]agentruntime.StreamEvent{{EventType: agentruntime.StreamEventMessageDelta, Data: delta}}); err == nil {
		t.Fatal("cross-scope delta was not reported")
	}
	envelope := nextEnvelope(t, frames)
	if envelope["payload"].(map[string]any)["eventType"] != activityEventSessionReconcileRequired {
		t.Fatalf("eventType = %v", envelope["payload"].(map[string]any)["eventType"])
	}
}

func TestTurnUpdateDataInjectsSessionIdentity(t *testing.T) {
	active := "turn-9"
	data := turnUpdateEventData("session-1", &canonical.WorkspaceAgentTurnStateUpdate{
		TurnID: "turn-9", Origin: "user_prompt", Phase: "running",
		ActiveTurnID: &active, StartedAtUnixMS: 10,
	}, 55)
	if data["occurredAtUnixMs"].(int64) != 55 || data["activeTurnId"] != "turn-9" {
		t.Fatalf("turn update data = %v", data)
	}
	turn, ok := data["turn"].(map[string]any)
	if !ok || turn["agentSessionId"] != "session-1" || turn["turnId"] != "turn-9" || turn["phase"] != "running" {
		t.Fatalf("turn payload = %v", data["turn"])
	}
}

func TestMessageUpdateDataCarriesVersionAndSequence(t *testing.T) {
	messages := []storesqlite.Message{{
		ID: 17, AgentSessionID: "session-1", MessageID: "message-1", Version: 3,
		TurnID: "turn-1", Role: "assistant", Kind: "text", Status: "completed",
		Payload: map[string]any{"text": "hello"}, OccurredAtUnixMS: 5,
		StartedAtUnixMS: 4, CompletedAtUnixMS: 6, CreatedAtUnixMS: 4, UpdatedAtUnixMS: 6,
	}}
	data := messageUpdateEventData(messages, 1, 3)
	if data["latestVersion"].(uint64) != 3 || data["acceptedCount"].(int) != 1 {
		t.Fatalf("cursors = %v", data)
	}
	projected := data["messages"].([]map[string]any)
	if len(projected) != 1 {
		t.Fatalf("messages = %v", data["messages"])
	}
	message := projected[0]
	if message["sequence"].(uint64) != 17 || message["version"].(uint64) != 3 || message["turnId"] != "turn-1" {
		t.Fatalf("message projection = %v", message)
	}
	if message["agentSessionId"] != "session-1" || message["payload"].(map[string]any)["text"] != "hello" {
		t.Fatalf("message identity/payload = %v", message)
	}
}

func TestRealtimePublishFilterDropsOptimisticRuntimeSnapshots(t *testing.T) {
	optimisticText := storesqlite.Message{
		ID: 1, AgentSessionID: "session-1", MessageID: "m-1", Version: 1, TurnID: "turn-1",
		Role: "assistant", Kind: "text", Status: "streaming",
		Payload: map[string]any{"contentMode": "snapshot"}, OccurredAtUnixMS: 1,
	}
	terminalText := storesqlite.Message{
		ID: 2, AgentSessionID: "session-1", MessageID: "m-1", Version: 2, TurnID: "turn-1",
		Role: "assistant", Kind: "text", Status: "completed",
		Payload: map[string]any{"text": "final"}, OccurredAtUnixMS: 2,
	}
	sessionLevel := storesqlite.Message{
		ID: 3, AgentSessionID: "session-1", MessageID: "m-2", Version: 3, TurnID: "",
		Role: "system", Kind: "notice", Status: "completed", OccurredAtUnixMS: 3,
	}
	messages := []storesqlite.Message{optimisticText, terminalText, sessionLevel}

	filtered := canonicalMessagesForRealtimePublish("WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME", messages)
	if len(filtered) != 2 || filtered[0].ID != 2 || filtered[1].ID != 3 {
		t.Fatalf("runtime-origin filter = %v", filtered)
	}
	// Non-runtime origins keep every committed snapshot.
	unfiltered := canonicalMessagesForRealtimePublish("WORKSPACE_AGENT_SESSION_ORIGIN_IMPORT", messages)
	if len(unfiltered) != 3 {
		t.Fatalf("import-origin filter = %v", unfiltered)
	}
}

func TestActivityMessagePageQuery(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/activity?afterVersion=12&limit=50", nil)
	afterVersion, limit, err := activityMessagePageQuery(request)
	if err != nil || afterVersion != 12 || limit != 50 {
		t.Fatalf("query = (%d, %d, %v)", afterVersion, limit, err)
	}
	request = httptest.NewRequest(http.MethodGet, "/activity", nil)
	afterVersion, limit, err = activityMessagePageQuery(request)
	if err != nil || afterVersion != 0 || limit != defaultActivityMessageLimit {
		t.Fatalf("defaults = (%d, %d, %v)", afterVersion, limit, err)
	}
	for _, query := range []string{"/activity?afterVersion=-1", "/activity?afterVersion=abc", "/activity?limit=0", "/activity?limit=100000"} {
		request := httptest.NewRequest(http.MethodGet, query, nil)
		if _, _, err := activityMessagePageQuery(request); err == nil {
			t.Fatalf("query %q was accepted", query)
		}
	}
}

// fakeRuntimeController satisfies agenthost.RuntimeController for read-surface
// tests; no provider runtime is started.
type fakeRuntimeController struct{}

func (fakeRuntimeController) Start(context.Context, agenthost.RuntimeStartInput) (agenthost.RuntimeStartResult, error) {
	return agenthost.RuntimeStartResult{}, nil
}
func (fakeRuntimeController) Resume(context.Context, agenthost.RuntimeResumeInput) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}
func (fakeRuntimeController) Session(string, string) (agenthost.ProviderRuntimeSession, bool) {
	return agenthost.ProviderRuntimeSession{}, false
}
func (fakeRuntimeController) CanResume(agenthost.RuntimeResumeInput) bool { return false }
func (fakeRuntimeController) Exec(context.Context, agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error) {
	return agenthost.RuntimeExecResult{}, nil
}
func (fakeRuntimeController) ValidatePromptContent(context.Context, agenthost.RuntimeExecInput) error {
	return nil
}
func (fakeRuntimeController) Cancel(context.Context, agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	return agenthost.RuntimeCancelResult{}, nil
}
func (fakeRuntimeController) SubmitInteractive(context.Context, agenthost.RuntimeSubmitInteractiveInput) (agenthost.RuntimeSubmitInteractiveResult, error) {
	return agenthost.RuntimeSubmitInteractiveResult{}, nil
}
func (fakeRuntimeController) InteractiveDisposition(string, string, string, string, string) agenthost.RuntimeInteractiveDisposition {
	return ""
}
func (fakeRuntimeController) UpdateSettings(context.Context, agenthost.RuntimeUpdateSettingsInput) error {
	return nil
}
func (fakeRuntimeController) SetTitle(context.Context, agenthost.RuntimeSetTitleInput) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}
func (fakeRuntimeController) SetVisible(context.Context, agenthost.RuntimeSetVisibleInput) (agenthost.ProviderRuntimeSession, error) {
	return agenthost.ProviderRuntimeSession{}, nil
}
func (fakeRuntimeController) Close(context.Context, agenthost.RuntimeCloseInput) error { return nil }
func (fakeRuntimeController) SupportsEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (bool, error) {
	return false, nil
}
func (fakeRuntimeController) ReadEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	return agenthost.RuntimeHistorySnapshot{}, nil
}
func (fakeRuntimeController) RollbackLatestTurn(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	return agenthost.RuntimeHistoryMutationResult{}, nil
}
func (fakeRuntimeController) GoalControl(context.Context, agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	return agenthost.RuntimeGoalControlResult{}, nil
}

func newTestServer(t *testing.T) (*httptest.Server, *storesqlite.Store) {
	return newTestServerWithOps(t, defaultProviderOps(nil))
}

func newTestServerWithOps(t *testing.T, ops *providerOps) (*httptest.Server, *storesqlite.Store) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-daemon-test.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;`); err != nil {
		t.Fatalf("configure SQLite: %v", err)
	}
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	workspaceStore := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(string) *storesqlite.Store { return store },
	}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: workspaceStore, TurnSubmissions: store,
		EffectiveHistory: store, SessionManagement: workspaceStore,
		RuntimeOperations: store, Runtime: fakeRuntimeController{},
		HistoryRuntime: fakeRuntimeController{}, GoalRuntime: fakeRuntimeController{},
		OperationOwner: "agorax-agentd-test", EditRetryDisabled: true,
	})
	handler := routesWithOps(nil, host, db, store, newEventHub(), ops)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, store
}

func seedSession(t *testing.T, store *storesqlite.Store, workspaceID, sessionID string) {
	t.Helper()
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
		Provider: "claude-code", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
}

func seedTurn(t *testing.T, store *storesqlite.Store, workspaceID, sessionID, turnID string, occurredAt int64) {
	t.Helper()
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: occurredAt,
	}); err != nil || !accepted {
		t.Fatalf("seed turn %s: accepted=%v err=%v", turnID, accepted, err)
	}
}

func seedMessage(t *testing.T, store *storesqlite.Store, workspaceID, sessionID, messageID, turnID string, occurredAt int64) {
	t.Helper()
	result, err := store.ReportSessionMessages(t.Context(), storesqlite.SessionMessageReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID,
		Messages: []storesqlite.MessageUpdate{{
			MessageID: messageID, TurnID: turnID, Role: "user", Kind: "text",
			Status: "completed", Payload: map[string]any{"text": messageID},
			OccurredAtUnixMS: occurredAt,
		}},
	})
	if err != nil {
		t.Fatalf("seed message: %v", err)
	}
	if result.AcceptedCount != 1 {
		t.Fatalf("seed message accepted = %d", result.AcceptedCount)
	}
}

func getJSON(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	response, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer response.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode GET %s: %v", url, err)
	}
	return response.StatusCode, body
}

func TestListAgentSessionsEndpointCarriesMessageVersionCursor(t *testing.T) {
	server, store := newTestServer(t)
	seedSession(t, store, "workspace-1", "session-a")
	seedSession(t, store, "workspace-1", "session-b")
	seedTurn(t, store, "workspace-1", "session-a", "turn-a1", 4)
	seedMessage(t, store, "workspace-1", "session-a", "message-a1", "turn-a1", 5)
	seedMessage(t, store, "workspace-1", "session-a", "message-a2", "turn-a1", 6)

	status, body := getJSON(t, server.URL+"/v1/workspaces/workspace-1/agent-sessions")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	if body["workspaceId"] != "workspace-1" {
		t.Fatalf("workspaceId = %v", body["workspaceId"])
	}
	sessions, ok := body["sessions"].([]any)
	if !ok || len(sessions) != 2 {
		t.Fatalf("sessions = %v", body["sessions"])
	}
	byID := map[string]map[string]any{}
	for _, raw := range sessions {
		session := raw.(map[string]any)
		byID[session["ID"].(string)] = session
	}
	// Empty session carries the authoritative cursor 0; the other carries the
	// high-water message version.
	if byID["session-b"]["MessageVersion"].(float64) != 0 {
		t.Fatalf("session-b MessageVersion = %v", byID["session-b"]["MessageVersion"])
	}
	if byID["session-a"]["MessageVersion"].(float64) != 2 {
		t.Fatalf("session-a MessageVersion = %v", byID["session-a"]["MessageVersion"])
	}

	status, body = getJSON(t, server.URL+"/v1/workspaces/unknown-workspace/agent-sessions")
	if status != http.StatusOK || len(body["sessions"].([]any)) != 0 {
		t.Fatalf("unknown workspace = (%d, %v)", status, body)
	}
}

func TestActivityEndpointPaginatesMessagesByAfterVersion(t *testing.T) {
	server, store := newTestServer(t)
	seedSession(t, store, "workspace-1", "session-1")
	seedTurn(t, store, "workspace-1", "session-1", "turn-1", 9)
	for index, messageID := range []string{"message-1", "message-2", "message-3"} {
		seedMessage(t, store, "workspace-1", "session-1", messageID, "turn-1", int64(10+index))
	}

	status, body := getJSON(t, server.URL+"/v1/workspaces/workspace-1/agent-sessions/session-1/activity?limit=2")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	messages := body["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages = %v", messages)
	}
	if body["messageVersion"].(float64) != 2 || body["hasMoreMessages"] != true {
		t.Fatalf("cursors = %v / %v", body["messageVersion"], body["hasMoreMessages"])
	}

	status, body = getJSON(t, server.URL+"/v1/workspaces/workspace-1/agent-sessions/session-1/activity?afterVersion=2")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %v", status, body)
	}
	messages = body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %v", messages)
	}
	if body["messageVersion"].(float64) != 3 || body["hasMoreMessages"] != false {
		t.Fatalf("cursors = %v / %v", body["messageVersion"], body["hasMoreMessages"])
	}

	// Default limit keeps the pre-existing 500 cap behaviour.
	status, body = getJSON(t, server.URL+"/v1/workspaces/workspace-1/agent-sessions/session-1/activity")
	if status != http.StatusOK || len(body["messages"].([]any)) != 3 || body["messageVersion"].(float64) != 3 {
		t.Fatalf("default page = (%d, %v)", status, body)
	}

	status, _ = getJSON(t, server.URL+"/v1/workspaces/workspace-1/agent-sessions/missing-session/activity")
	if status != http.StatusNotFound {
		t.Fatalf("missing session status = %d", status)
	}
}

func TestReporterPublishesEnvelopeEventsEndToEnd(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent-reporter-test.db"))
	if err != nil {
		t.Fatalf("open SQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate SQLite: %v", err)
	}
	hub := newEventHub()
	frames, unsubscribe := hubFrames(hub)
	defer unsubscribe()
	reporter := &localCanonicalReporter{store: store, hub: hub}

	if _, err := reporter.ReportSessionState(t.Context(), canonical.ReportSessionStateInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Provider:         "claude-code",
			OccurredAtUnixMS: 7,
			Turn: &canonical.WorkspaceAgentTurnStateUpdate{
				TurnID: "turn-1", Origin: "user_prompt", Phase: "submitted", StartedAtUnixMS: 7,
			},
		},
	}); err != nil {
		t.Fatalf("ReportSessionState: %v", err)
	}
	turnEnvelope := nextEnvelope(t, frames)
	turnPayload := turnEnvelope["payload"].(map[string]any)
	if turnPayload["eventType"] != activityEventTurnUpdate {
		t.Fatalf("eventType = %v", turnPayload["eventType"])
	}
	turnData := turnPayload["data"].(map[string]any)
	if turnData["turn"].(map[string]any)["agentSessionId"] != "session-1" {
		t.Fatalf("turn data = %v", turnData)
	}

	if _, err := reporter.ReportSessionMessages(t.Context(), canonical.ReportSessionMessagesInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		SessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORT",
		Source:        canonical.EventSource{Provider: "claude-code"},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1", TurnID: "turn-1", Role: "user", Kind: "text",
			Status: "completed", Payload: map[string]any{"text": "hello"}, OccurredAtUnixMS: 8,
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages: %v", err)
	}
	messageEnvelope := nextEnvelope(t, frames)
	messagePayload := messageEnvelope["payload"].(map[string]any)
	if messagePayload["eventType"] != activityEventMessageUpdate {
		t.Fatalf("eventType = %v", messagePayload["eventType"])
	}
	messageData := messagePayload["data"].(map[string]any)
	if messageData["latestVersion"].(float64) != 1 || messageData["acceptedCount"].(float64) != 1 {
		t.Fatalf("message cursors = %v", messageData)
	}
	projected := messageData["messages"].([]any)[0].(map[string]any)
	if projected["messageId"] != "message-1" || projected["version"].(float64) != 1 || projected["sequence"].(float64) <= 0 {
		t.Fatalf("projected message = %v", projected)
	}
	if turnEnvelope["version"].(float64) >= messageEnvelope["version"].(float64) {
		t.Fatalf("versions not monotonic: %v then %v", turnEnvelope["version"], messageEnvelope["version"])
	}
}

func TestNewEventIDIsUniqueAndFormatted(t *testing.T) {
	seen := map[string]struct{}{}
	for index := 0; index < 256; index++ {
		id := newEventID()
		if len(id) != 36 || strings.Count(id, "-") != 4 {
			t.Fatalf("id %q is not UUID-shaped", id)
		}
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = struct{}{}
	}
}
