package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	agentdaemon "agorax.local/agent-daemon/packages/agent/daemon"
	activity "agorax.local/agent-daemon/packages/agent/daemon/activity"
	hostadapter "agorax.local/agent-daemon/packages/agent/daemon/hostadapter"
	"agorax.local/agent-daemon/packages/agent/daemon/modelcatalog"
	agentruntime "agorax.local/agent-daemon/packages/agent/daemon/runtime"
	agenthost "agorax.local/agent-daemon/packages/agent/host"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
	canonical "agorax.local/agent-daemon/packages/agent/store-sqlite/canonical"
	"golang.org/x/net/websocket"
	_ "modernc.org/sqlite"
)

const defaultPort = 8788

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := sql.Open("sqlite", agentDBPath())
	if err != nil {
		return fmt.Errorf("open Agorax agent database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;`); err != nil {
		return fmt.Errorf("configure Agorax SQLite: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at_unix_ms INTEGER NOT NULL, updated_at_unix_ms INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create Agorax workspace registry: %w", err)
	}
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate Agorax agent database: %w", err)
	}
	workspaceStore := &agenthost.SQLiteWorkspaceStore{
		StoreForWorkspace: func(string) *storesqlite.Store { return store },
	}
	hub := newEventHub()
	canonicalReporter := &localCanonicalReporter{store: store, hub: hub}
	localReporter := &localDurableReporter{adapter: activity.NewSessionActivityReporterAdapter(canonicalReporter)}
	runtime, err := agentdaemon.NewRuntime(agentdaemon.Config{
		Reporter: localReporter,
		HostMetadata: agentdaemon.HostMetadata{
			ClientInfo:       agentdaemon.ClientInfo{Name: "agorax", Title: "Agorax", Version: "0.1.0"},
			WorkspaceEnvName: "AGORAX_WORKSPACE_ID", OpenClawSessionKeyPrefix: "agent:main:agorax-",
		},
		ProcessTransport: agentdaemon.NewLocalProcessTransport(),
	})
	if err != nil {
		return fmt.Errorf("create Agorax agent runtime with reporter: %w", err)
	}
	defer runtime.Close()
	// Tutti wires ObserveRootTurnSettled → ReconcileRootTurnSettlement after the
	// store aggregates RootProviderTurn completion into a settled root turn.
	// Slim agorax-agentd must do the same, or ACP adapters (Kimi/Cursor/…) leave
	// the in-memory active turn forever and follow-up SendInput fails with
	// ErrSessionActiveTurn.
	canonicalReporter.controller = runtime.Controller()
	// Project the precommit runtime stream (message_delta text/toolOutput/
	// payload operations and loss signals) into the public activity WS.
	runtime.Controller().SetStreamEventObserver(&agentActivityEventBridge{hub: hub})
	hostRuntime := &hostadapter.RuntimeController{Backend: runtime.Controller()}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: workspaceStore, TurnSubmissions: store,
		EffectiveHistory: store, SessionManagement: workspaceStore,
		SessionBatchManagement: workspaceStore,
		RuntimeOperations:      store, Runtime: hostRuntime,
		HistoryRuntime: hostRuntime, GoalRuntime: hostRuntime,
		OperationOwner: "agorax-agentd", EditRetryDisabled: true,
	})

	server := &http.Server{
		Addr:              listenAddress(),
		Handler:           routes(runtime, host, db, store, hub),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func listenAddress() string {
	host := os.Getenv("AGORAX_MANAGED_AGENT_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := defaultPort
	if value, err := strconv.Atoi(os.Getenv("AGORAX_MANAGED_AGENT_PORT")); err == nil && value > 0 && value < 65536 {
		port = value
	}
	return fmt.Sprintf("%s:%d", host, port)
}

func agentDBPath() string {
	if value := os.Getenv("AGORAX_AGENT_DB_PATH"); value != "" {
		return value
	}
	return "agorax-agent.db"
}

func routes(runtime *agentdaemon.Runtime, host *agenthost.Host, db *sql.DB, store *storesqlite.Store, hub *eventHub) http.Handler {
	ops := defaultProviderOps(func() map[string]bool {
		registered := map[string]bool{}
		if runtime != nil {
			for _, provider := range runtime.Controller().RegisteredProviders() {
				registered[provider] = true
			}
		}
		return registered
	})
	ops.attachTargetStore(store)
	if err := ops.hydrateEnabledFromStore(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "agorax-agentd: load provider enable preferences: %v\n", err)
	}
	if runtime != nil && runtime.Controller() != nil {
		ops.applyEnabledPreferencesToRuntime(runtime.Controller().SetProviderEnabled)
	}
	return routesWithOps(runtime, host, db, store, hub, ops)
}

func routesWithOps(runtime *agentdaemon.Runtime, host *agenthost.Host, db *sql.DB, store *storesqlite.Store, hub *eventHub, ops *providerOps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":      true,
			"runtime": "agorax-managed-agent",
		})
	})
	mux.HandleFunc("GET /v1/agent-targets", func(response http.ResponseWriter, _ *http.Request) {
		registered := map[string]bool{}
		if runtime != nil {
			for _, provider := range runtime.Controller().RegisteredProviders() {
				registered[provider] = true
			}
		}
		// enabled reflects the providers that actually have a registered
		// runtime adapter. claude-code is hosted by the daemon's Claude CLI
		// adapter; kimi-code is a host ACP adapter registered as acp:kimi-code.
		// When a Runtimes preference exists, it gates the enabled flag.
		target := func(id string, provider string, identity string) map[string]any {
			enabled := registered[provider]
			if pref, ok := ops.userEnabledPreference(identity); ok {
				enabled = pref && enabled
			}
			return map[string]any{"id": id, "enabled": enabled}
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"agents": []any{
				target("local:claude-code", "claude-code", "claude-code"),
				target("local:codex", "codex", "codex"),
				target("local:cursor", "cursor", "cursor"),
				target("local:opencode", "opencode", "opencode"),
				target("extension:kimi-code", "acp:kimi-code", "kimi-code"),
			},
			"runtimeReady": runtime != nil,
		})
	})
	mux.HandleFunc("GET /v1/provider-status", ops.handleProviderStatus)
	mux.HandleFunc("POST /v1/providers/{provider}/install", ops.handleProviderInstall)
	mux.HandleFunc("POST /v1/providers/{provider}/login", ops.handleProviderLogin)
	mux.HandleFunc("POST /v1/providers/{provider}/enable", func(response http.ResponseWriter, request *http.Request) {
		providerID := strings.TrimSpace(request.PathValue("provider"))
		descriptor, ok := findProviderTarget(providerID)
		if !ok {
			writeJSON(response, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("unknown provider %q", providerID)})
			return
		}
		var body struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := ops.setUserEnabledPreference(descriptor.Identity.ID, body.Enabled); err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if runtime != nil && runtime.Controller() != nil {
			for _, key := range providerEnableAliases(descriptor) {
				runtime.Controller().SetProviderEnabled(key, body.Enabled)
			}
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"provider": descriptor.Identity.ID,
			"enabled":  body.Enabled,
		})
	})
	mux.Handle("GET /v1/events/ws", websocket.Server{
		// The default websocket.Handler handshake rejects requests without an
		// Origin header ("null origin"), which breaks non-browser clients
		// (node ws, the workspace server's shared subscription). The daemon is
		// a localhost transport — accept any or no origin explicitly.
		Handshake: func(_ *websocket.Config, _ *http.Request) error { return nil },
		Handler: func(connection *websocket.Conn) {
			defer connection.Close()
			channel, unsubscribe := hub.subscribe()
			defer unsubscribe()
			for payload := range channel {
				if _, err := connection.Write(payload); err != nil {
					return
				}
			}
		},
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions", func(response http.ResponseWriter, request *http.Request) {
		workspaceID := request.PathValue("workspaceID")
		sessions, found, err := store.ListSessions(request.Context(), workspaceID)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if !found {
			sessions = []storesqlite.Session{}
		}
		// Thin read adapter over the canonical store: the session row already
		// carries the MessageVersion high-water cursor (authoritative 0 for a
		// session with no accepted message changes).
		writeJSON(response, http.StatusOK, map[string]any{"workspaceId": workspaceID, "sessions": sessions})
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions", func(response http.ResponseWriter, request *http.Request) {
		workspaceID := request.PathValue("workspaceID")
		now := time.Now().UnixMilli()
		if _, err := db.ExecContext(request.Context(), `INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at_unix_ms=excluded.updated_at_unix_ms`, workspaceID, workspaceID, now, now); err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		var input struct {
			AgentSessionID  string          `json:"agentSessionId"`
			AgentTargetID   string          `json:"agentTargetId"`
			Provider        string          `json:"provider"`
			ClientSubmitID  string          `json:"clientSubmitId"`
			Content         json.RawMessage `json:"content"`
			InitialContent  json.RawMessage `json:"initialContent"`
			// UI-only text when InitialContent carries injected skills / bundles.
			DisplayPrompt   string          `json:"displayPrompt"`
			CWD             string          `json:"cwd"`
			Model           string          `json:"model"`
			ReasoningEffort string          `json:"reasoningEffort"`
			// Optional per-run Mission MCP handshake (Agorax workspace control channel).
			McpEndpoint     string   `json:"mcpEndpoint"`
			McpRunToken     string   `json:"mcpRunToken"`
			McpToolAllowlist []string `json:"mcpToolAllowlist"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		content := promptText(input.Content)
		if len(content) == 0 {
			content = promptText(input.InitialContent)
		}
		provider := input.Provider
		if provider == "" {
			provider = providerFromTarget(input.AgentTargetID)
		}
		var runtimeContext map[string]any
		if strings.TrimSpace(input.McpEndpoint) != "" && strings.TrimSpace(input.McpRunToken) != "" {
			runtimeContext = map[string]any{
				"agoraxMissionMcp": map[string]any{
					"endpoint":      strings.TrimSpace(input.McpEndpoint),
					"runToken":      strings.TrimSpace(input.McpRunToken),
					"toolAllowlist": input.McpToolAllowlist,
				},
			}
		}
		result, err := host.CreateSession(request.Context(), workspaceID, agenthost.CreateSessionInput{
			AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
			Provider: provider, ClientSubmitID: input.ClientSubmitID,
			InitialContent: content,
			InitialDisplayPrompt: strings.TrimSpace(input.DisplayPrompt),
			Cwd:            stringPointer(input.CWD), Model: stringPointer(input.Model),
			ReasoningEffort: stringPointer(input.ReasoningEffort),
			RuntimeContext:  runtimeContext,
		})
		if err != nil {
			// Delivery-unknown is not a failure: the turn is durably submitted
			// and its outcome arrives via events/reconcile. Surface the result
			// (SessionStatus "unknown") instead of a 4xx so clients don't
			// report a spurious error while the provider is still starting.
			if errors.Is(err, agenthost.ErrSubmitDeliveryUnknown) {
				writeJSON(response, http.StatusCreated, result)
				return
			}
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusCreated, result)
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/input", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			ClientSubmitID string          `json:"clientSubmitId"`
			Content        json.RawMessage `json:"content"`
			// UI-only text when Content carries injected skills / bundles.
			DisplayPrompt  string          `json:"displayPrompt"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := host.SendInput(request.Context(), agenthost.SessionRef{WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID")}, agenthost.SendInput{
			ClientSubmitID: input.ClientSubmitID,
			Content:        promptText(input.Content),
			DisplayPrompt:  strings.TrimSpace(input.DisplayPrompt),
		})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/cancel", func(response http.ResponseWriter, request *http.Request) {
		result, err := host.CancelTurn(request.Context(), agenthost.CancelTurnInput{WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"), TurnID: request.PathValue("turnID"), Reason: "user_requested"})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/interactions", func(response http.ResponseWriter, request *http.Request) {
		workspaceID, agentSessionID := request.PathValue("workspaceID"), request.PathValue("agentSessionID")
		snapshot, err := host.GetSessionInteractionSnapshot(request.Context(), agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID})
		if err != nil {
			writeJSON(response, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"workspaceId": workspaceID, "agentSessionId": agentSessionID, "interactions": nonNilSlice(snapshot.Interactions)})
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/activity", func(response http.ResponseWriter, request *http.Request) {
		workspaceID, agentSessionID := request.PathValue("workspaceID"), request.PathValue("agentSessionID")
		ref := agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}
		session, err := host.GetSession(request.Context(), ref)
		if err != nil {
			writeJSON(response, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		turns, err := host.ListCanonicalSessionTurns(request.Context(), ref)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		afterVersion, limit, err := activityMessagePageQuery(request)
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		messages, _, err := host.ListSessionMessages(request.Context(), ref, agenthost.SessionMessageQuery{
			AfterVersion: afterVersion, Limit: limit, Order: storesqlite.MessageOrderAsc,
		})
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		interactions, err := host.GetSessionInteractionSnapshot(request.Context(), ref)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"workspaceId":     workspaceID,
			"session":         session.Canonical,
			"turns":           nonNilSlice(turns),
			// Prefer displayPrompt over injected skill bodies on the wire so
			// sidebar hydrate is not multi-MB for a single user turn.
			"messages":        nonNilSlice(compactActivityMessagesForWire(messages.Messages)),
			"interactions":    nonNilSlice(interactions.Interactions),
			"messageVersion":  messages.LatestVersion,
			"hasMoreMessages": messages.HasMore,
		})
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/interactions/{requestID}/response", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Action   string         `json:"action"`
			OptionID string         `json:"optionId"`
			Payload  map[string]any `json:"payload"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		workspaceID, agentSessionID, turnID, requestID := request.PathValue("workspaceID"), request.PathValue("agentSessionID"), request.PathValue("turnID"), request.PathValue("requestID")
		result, err := host.SubmitInteractive(request.Context(), agenthost.InteractionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID, TurnID: turnID, RequestID: requestID}, agenthost.SubmitInteractiveInput{Action: stringPointer(input.Action), OptionID: stringPointer(input.OptionID), Payload: input.Payload})
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		interaction, found, err := host.GetInteraction(request.Context(), agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}, turnID, requestID)
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if found && hub != nil {
			hub.publishActivity(workspaceID, agentSessionID, activityEventInteractionUpdate, interactionUpdateEventData(interaction, time.Now().UnixMilli()))
		}
		writeJSON(response, http.StatusOK, result)
	})

	// Session management surfaces (Host APIs already owned the lifecycle;
	// these routes are thin HTTP adapters matching Agorax's agorax-agentd shape).
	mux.HandleFunc("PATCH /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/title", handleUpdateTitle(host))
	mux.HandleFunc("PUT /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/title", handleUpdateTitle(host))
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/title", handleUpdateTitle(host))
	mux.HandleFunc("DELETE /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}", func(response http.ResponseWriter, request *http.Request) {
		result, err := host.DeleteSession(request.Context(), agenthost.SessionRef{
			WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"),
		})
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/pin", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Pinned bool `json:"pinned"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := host.UpdatePin(request.Context(), agenthost.UpdatePinInput{
			WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"), Pinned: input.Pinned,
		})
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/cwd", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Cwd string `json:"cwd"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := host.RemountSessionCwd(request.Context(), agenthost.RemountSessionCwdInput{
			WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"),
			Cwd: input.Cwd,
		})
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"remounted": result.Remounted,
			"live":      result.Live,
			"canonical": result.Canonical,
		})
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/settings", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Model           *string `json:"model"`
			ReasoningEffort *string `json:"reasoningEffort"`
			PermissionModeID *string `json:"permissionModeId"`
			PlanMode        *bool   `json:"planMode"`
			Speed           *string `json:"speed"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := host.UpdateSettings(request.Context(), agenthost.UpdateSettingsInput{
			WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"),
			Settings: agenthost.ComposerSettingsPatch{
				Model: input.Model, ReasoningEffort: input.ReasoningEffort,
				PermissionModeID: input.PermissionModeID, PlanMode: input.PlanMode, Speed: input.Speed,
			},
		})
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/composer-options", func(response http.ResponseWriter, request *http.Request) {
		workspaceID, agentSessionID := request.PathValue("workspaceID"), request.PathValue("agentSessionID")
		session, err := host.GetSession(request.Context(), agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID})
		if err != nil {
			writeHostError(response, err)
			return
		}
		provider := strings.TrimSpace(session.Canonical.Provider)
		requestedModel := strings.TrimSpace(session.Canonical.Model)
		if settings := composerSettingsFromMap(session.Canonical.Settings); settings.Model != "" {
			requestedModel = settings.Model
		}
		writeJSON(response, http.StatusOK, projectComposerOptions(provider, requestedModel))
	})
	mux.HandleFunc("GET /v1/agent-providers/{provider}/composer-options", func(response http.ResponseWriter, request *http.Request) {
		provider := strings.TrimSpace(request.PathValue("provider"))
		if provider == "" {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "provider is required"})
			return
		}
		requestedModel := strings.TrimSpace(request.URL.Query().Get("model"))
		writeJSON(response, http.StatusOK, projectComposerOptions(provider, requestedModel))
	})
	mux.HandleFunc("POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/plan-decisions/{requestID}", func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			PromptKind     string `json:"promptKind"`
			Action         string `json:"action"`
			IdempotencyKey string `json:"idempotencyKey"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		operation, err := host.SubmitPlanDecision(
			request.Context(),
			agenthost.SessionRef{WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID")},
			request.PathValue("turnID"),
			request.PathValue("requestID"),
			agenthost.SubmitPlanDecisionInput{
				PromptKind: input.PromptKind, Action: input.Action, IdempotencyKey: input.IdempotencyKey,
			},
		)
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"operation": operation})
	})
	mux.HandleFunc("GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/goal", func(response http.ResponseWriter, request *http.Request) {
		result, err := host.GetGoalState(request.Context(), agenthost.SessionRef{
			WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"),
		})
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	return mux
}

func handleUpdateTitle(host *agenthost.Host) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var input struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := host.UpdateTitle(request.Context(), agenthost.UpdateTitleInput{
			WorkspaceID: request.PathValue("workspaceID"), AgentSessionID: request.PathValue("agentSessionID"), Title: input.Title,
		})
		if err != nil {
			writeHostError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}

func writeHostError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agenthost.ErrSessionNotFound):
		writeJSON(response, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, agenthost.ErrInvalidArgument), errors.Is(err, agenthost.ErrSessionTitleTooLong):
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

// projectComposerOptions builds the composer-options REST body from local
// provider config (Claude settings.json / Codex config.toml) when available.
// Missing config yields an empty options list (fail-closed, never invented).
func projectComposerOptions(provider, requestedModel string) map[string]any {
	models := modelcatalog.LoadLocalProviderModels(provider)
	projection := modelcatalog.ProjectComposerCatalog(models, requestedModel)
	modelOptions := make([]map[string]any, 0, len(models))
	for _, model := range models {
		modelOptions = append(modelOptions, map[string]any{
			"value": model.ID,
			"label": firstNonBlank(model.DisplayName, model.ID),
			"name":  firstNonBlank(model.DisplayName, model.ID),
			"id":    model.ID,
			"default": model.IsDefault,
		})
	}
	reasoningByModel := map[string]any{}
	for modelID, profile := range projection.ReasoningOptionsByModel {
		options := make([]map[string]any, 0, len(profile.Options))
		for _, option := range profile.Options {
			options = append(options, map[string]any{
				"value": option.Value, "label": firstNonBlank(option.Label, option.Value),
				"description": option.Description, "default": option.Default,
			})
		}
		reasoningByModel[modelID] = map[string]any{
			"defaultValue": profile.DefaultValue, "options": options,
		}
	}
	effectiveModel := strings.TrimSpace(requestedModel)
	if projection.Selection.Found {
		effectiveModel = projection.Selection.Model.ID
	}
	reasoningConfigurable := projection.Selection.ReasoningEffortsAdvertised &&
		len(projection.Selection.ReasoningEfforts) > 0
	reasoningOptions := make([]map[string]any, 0, len(projection.Selection.ReasoningEfforts))
	for _, option := range projection.Selection.ReasoningEfforts {
		reasoningOptions = append(reasoningOptions, map[string]any{
			"value": option.Value, "label": firstNonBlank(option.Label, option.Value),
			"description": option.Description, "default": option.Default,
		})
	}
	reasoningDefault := projection.Selection.DefaultReasoningEffort
	return map[string]any{
		"provider":                provider,
		"codexSaverModeSupported": false,
		"rtkSaverModeSupported":   false,
		"capabilities":            nil,
		"modelConfig": map[string]any{
			"configurable":   len(modelOptions) > 0,
			"effectiveValue": effectiveModel,
			"currentValue":   effectiveModel,
			"defaultValue":   effectiveModel,
			"options":        modelOptions,
		},
		"reasoningConfig": map[string]any{
			"configurable":   reasoningConfigurable,
			"effectiveValue": reasoningDefault,
			"currentValue":   reasoningDefault,
			"defaultValue":   reasoningDefault,
			"options":        reasoningOptions,
		},
		"speedConfig": map[string]any{
			"configurable":   false,
			"effectiveValue": "",
			"currentValue":   "",
			"defaultValue":   "",
			"options":        []any{},
		},
		"reasoningOptionsByModel": reasoningByModel,
		"effectiveSettings": map[string]any{
			"model": effectiveModel, "reasoningEffort": reasoningDefault, "speed": "",
		},
		"permissionConfig": map[string]any{
			"configurable": false, "defaultValue": "", "currentValue": "", "modes": []any{},
		},
		"runtimeContext": map[string]any{},
		"skills":         []any{},
		"commands":       []any{},
		"capabilityCatalog": []any{},
		"behavior": map[string]any{
			"collapseModelOptionsToLatest":     false,
			"modelOptionsAuthoritative":        true,
			"refreshModelOptionsAfterSettings": false,
			"prewarmDraftSession":              false,
			"planModeExclusiveWithPermissionMode": false,
		},
		"slashCommandPolicy": map[string]any{
			"fallbackCommands": []any{}, "commandEffects": []any{}, "commandCatalogAuthoritative": false,
		},
	}
}

func composerSettingsFromMap(settings map[string]any) agenthost.ComposerSettings {
	if settings == nil {
		return agenthost.ComposerSettings{}
	}
	asString := func(key string) string {
		value, _ := settings[key].(string)
		return strings.TrimSpace(value)
	}
	return agenthost.ComposerSettings{
		Model: asString("model"), ReasoningEffort: asString("reasoningEffort"), Speed: asString("speed"),
		PermissionModeID: asString("permissionModeId"),
	}
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

const (
	defaultActivityMessageLimit = 500
	maxActivityMessageLimit     = 1000
)

// compactActivityMessagesForWire replaces bulky provider `content` / `text`
// with `displayPrompt` when present (skills injection stays in durable storage
// for the model path, but list/detail hydrate must stay small).
func compactActivityMessagesForWire(messages []storesqlite.Message) []storesqlite.Message {
	if len(messages) == 0 {
		return messages
	}
	out := make([]storesqlite.Message, len(messages))
	for i, message := range messages {
		out[i] = message
		display, _ := message.Payload["displayPrompt"].(string)
		display = strings.TrimSpace(display)
		if display == "" {
			continue
		}
		payload := make(map[string]any, len(message.Payload))
		for key, value := range message.Payload {
			payload[key] = value
		}
		payload["content"] = []map[string]any{{"type": "text", "text": display}}
		payload["text"] = display
		out[i].Payload = payload
	}
	return out
}

// activityMessagePageQuery parses the version-cursor pagination contract for
// the activity read surface: ascending pages keyed by afterVersion with a
// bounded page size.
func activityMessagePageQuery(request *http.Request) (afterVersion uint64, limit int, err error) {
	if raw := strings.TrimSpace(request.URL.Query().Get("afterVersion")); raw != "" {
		parsed, parseErr := strconv.ParseUint(raw, 10, 64)
		if parseErr != nil {
			return 0, 0, fmt.Errorf("invalid afterVersion %q: %w", raw, parseErr)
		}
		afterVersion = parsed
	}
	limit = defaultActivityMessageLimit
	if raw := strings.TrimSpace(request.URL.Query().Get("limit")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed <= 0 {
			return 0, 0, fmt.Errorf("invalid limit %q: must be a positive integer", raw)
		}
		if parsed > maxActivityMessageLimit {
			return 0, 0, fmt.Errorf("invalid limit %q: exceeds maximum %d", raw, maxActivityMessageLimit)
		}
		limit = parsed
	}
	return afterVersion, limit, nil
}

func completedCommandString(command *canonical.WorkspaceAgentCompletedCommand, kind bool) string {
	if command == nil {
		return ""
	}
	if kind {
		return strings.TrimSpace(command.Kind)
	}
	return strings.TrimSpace(command.Status)
}

func promptText(raw json.RawMessage) []agenthost.PromptContentBlock {
	if len(raw) == 0 {
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil && text != "" {
		return []agenthost.PromptContentBlock{{Type: "text", Text: text}}
	}
	var blocks []agenthost.PromptContentBlock
	if json.Unmarshal(raw, &blocks) == nil {
		return blocks
	}
	return nil
}

func providerFromTarget(target string) string {
	switch target {
	case "local:claude-code":
		return "claude-code"
	case "local:codex":
		return "codex"
	case "local:cursor":
		return "cursor"
	case "local:opencode":
		return "opencode"
	case "extension:kimi-code":
		// Must match the runtime adapter Provider() / agent-targets catalog key.
		return "acp:kimi-code"
	default:
		return target
	}
}

type localDurableReporter struct {
	adapter *activity.SessionActivityReporterAdapter
}

func (r *localDurableReporter) Report(ctx context.Context, input activity.ReportActivityInput) error {
	return r.adapter.Report(ctx, input)
}
func (r *localDurableReporter) ReportSubmitProvenance(ctx context.Context, input activity.ReportActivityInput) error {
	return r.adapter.Report(ctx, input)
}

type localCanonicalReporter struct {
	store      *storesqlite.Store
	hub        *eventHub
	controller *agentruntime.Controller
}

func (r *localCanonicalReporter) ReportSessionState(ctx context.Context, input canonical.ReportSessionStateInput) (canonical.ReportSessionStateReply, error) {
	s := input.State
	report := storesqlite.ActivityStateReport{Session: storesqlite.SessionStateReport{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Kind: s.Kind,
		RootAgentSessionID: s.RootAgentSessionID, RootTurnID: s.RootTurnID,
		ParentAgentSessionID: s.ParentAgentSessionID, ParentTurnID: s.ParentTurnID,
		ParentToolCallID: s.ParentToolCallID, AgentTargetID: s.AgentTargetID,
		Provider: s.Provider, ProviderSessionID: s.ProviderSessionID, Model: s.Model,
		Settings: s.Settings, Capabilities: s.Capabilities, RuntimeContext: s.RuntimeContext,
		RuntimeContextPatch: s.RuntimeContextPatch, Cwd: s.CWD, Title: s.Title,
		Status: s.LifecycleStatus, CurrentPhase: s.CurrentPhase, LastError: s.LastError,
		OccurredAtUnixMS: s.OccurredAtUnixMS,
	}}
	if s.InteractionTransition != nil {
		report.Interaction = interactionUpsert(input.WorkspaceID, input.AgentSessionID, s.InteractionTransition, s.OccurredAtUnixMS)
	}
	if s.Turn != nil {
		report.Turn = &storesqlite.TurnTransition{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			TurnID: s.Turn.TurnID, Phase: s.Turn.Phase, Outcome: s.Turn.Outcome,
			ErrorCode: s.Turn.ErrorCode, ErrorMessage: s.Turn.ErrorMessage,
			Origin: s.Turn.Origin, FileChanges: s.Turn.FileChanges,
			SourceGoalOperationID: s.Turn.SourceGoalOperationID, SourceGoalRevision: s.Turn.SourceGoalRevision,
			SourceGoalRepairEpoch: s.Turn.SourceGoalRepairEpoch, StartedAtUnixMS: s.Turn.StartedAtUnixMS,
			SettledAtUnixMS: s.Turn.CompletedAtUnixMS, OccurredAtUnixMS: s.OccurredAtUnixMS,
		}
	}
	if s.RootProviderTurn != nil {
		// Without this the provider turn binding never reaches the canonical
		// store, so resume evidence stays "not established" and the next
		// SendInput is rejected with ErrProviderSessionNotEstablished.
		report.RootProviderTurn = &storesqlite.RootProviderTurnTransition{
			WorkspaceID:             input.WorkspaceID,
			RootAgentSessionID:      input.AgentSessionID,
			RootTurnID:              s.RootProviderTurn.RootTurnID,
			ProviderTurnID:          s.RootProviderTurn.ProviderTurnID,
			ProviderTurnBindingJSON: append(json.RawMessage(nil), s.RootProviderTurn.ProviderTurnBindingJSON...),
			Phase:                   s.RootProviderTurn.Phase,
			Outcome:                 s.RootProviderTurn.Outcome,
			ErrorMessage:            s.RootProviderTurn.ErrorMessage,
			ErrorCode:               s.RootProviderTurn.ErrorCode,
			CompletedCommandKind:    completedCommandString(s.RootProviderTurn.CompletedCommand, true),
			CompletedCommandStatus:  completedCommandString(s.RootProviderTurn.CompletedCommand, false),
			OccurredAtUnixMS:        s.OccurredAtUnixMS,
		}
	}
	result, err := r.store.ReportActivityState(ctx, report)
	if err != nil {
		return canonical.ReportSessionStateReply{}, err
	}
	if r.hub != nil && s.Turn != nil {
		r.hub.publishActivity(input.WorkspaceID, input.AgentSessionID, activityEventTurnUpdate,
			turnUpdateEventData(input.AgentSessionID, s.Turn, s.OccurredAtUnixMS))
	}
	// When RootProviderTurn completion settles the canonical root (no active
	// children), release the runtime active-turn fence and publish the settled
	// turn — matching Tutti's ObserveRootTurnSettled path.
	if result.RootTurnAccepted && result.RootTurn.Phase == storesqlite.TurnPhaseSettled {
		r.reconcileSettledRootTurn(input.WorkspaceID, input.AgentSessionID, result.RootTurn)
		if r.hub != nil && s.Turn == nil {
			r.hub.publishActivity(input.WorkspaceID, input.AgentSessionID, activityEventTurnUpdate,
				turnUpdateEventData(input.AgentSessionID, result.RootTurn, s.OccurredAtUnixMS))
		}
	} else if result.TurnAccepted && result.Turn.Phase == storesqlite.TurnPhaseSettled {
		r.reconcileSettledRootTurn(input.WorkspaceID, input.AgentSessionID, result.Turn)
	}
	if r.hub != nil && result.InteractionResult == storesqlite.InteractionTransitionApplied {
		r.publishInteraction(input.WorkspaceID, input.AgentSessionID, result.Interaction)
	}
	return canonical.ReportSessionStateReply{Accepted: result.State.Accepted, StateApplied: result.State.StateApplied, LastEventAtUnixMS: result.State.LastEventUnixMS}, nil
}

func (r *localCanonicalReporter) reconcileSettledRootTurn(
	workspaceID string,
	agentSessionID string,
	turn storesqlite.Turn,
) {
	if r == nil || r.controller == nil {
		return
	}
	turnID := strings.TrimSpace(turn.TurnID)
	if strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(agentSessionID) == "" || turnID == "" {
		return
	}
	r.controller.ReconcileRootTurnSettlement(agentruntime.RootTurnSettlement{
		RoomID:         workspaceID,
		AgentSessionID: agentSessionID,
		TurnID:         turnID,
		Outcome:        turn.Outcome,
		ErrorMessage:   turn.ErrorMessage,
	})
}

func (r *localCanonicalReporter) ReportSessionMessages(ctx context.Context, input canonical.ReportSessionMessagesInput) (canonical.ReportSessionMessagesReply, error) {
	updates := make([]storesqlite.MessageUpdate, 0, len(input.Updates))
	for _, message := range input.Updates {
		updates = append(updates, storesqlite.MessageUpdate{MessageID: message.MessageID, TurnID: message.TurnID, Role: message.Role, Kind: message.Kind, Status: message.Status, ContentDelta: message.ContentDelta, Payload: message.Payload, OccurredAtUnixMS: message.OccurredAtUnixMS, StartedAtUnixMS: message.StartedAtUnixMS, CompletedAtUnixMS: message.CompletedAtUnixMS})
	}
	result, err := r.store.ReportSessionMessages(ctx, storesqlite.SessionMessageReport{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Provider: input.Source.Provider, Messages: updates})
	if err != nil {
		return canonical.ReportSessionMessagesReply{}, err
	}
	if r.hub != nil && result.AcceptedCount > 0 {
		// Full committed snapshots with version cursors; optimistic runtime
		// text/tool-output snapshots were already streamed as message_delta.
		published := canonicalMessagesForRealtimePublish(input.SessionOrigin, result.Messages)
		if len(published) > 0 {
			latestVersion := result.LatestVersion
			if latestVersion == 0 {
				for _, message := range published {
					if message.Version > latestVersion {
						latestVersion = message.Version
					}
				}
			}
			agentSessionID := input.AgentSessionID
			for _, message := range published {
				if message.AgentSessionID != "" {
					agentSessionID = message.AgentSessionID
					break
				}
			}
			r.hub.publishActivity(input.WorkspaceID, agentSessionID, activityEventMessageUpdate,
				messageUpdateEventData(published, result.AcceptedCount, latestVersion))
		}
	}
	return canonical.ReportSessionMessagesReply{AcceptedCount: result.AcceptedCount, LatestVersion: result.LatestVersion}, nil
}

type localActivityReporter struct {
	store *storesqlite.Store
	hub   *eventHub
}

// localActivityReporter is retained as the direct ReportActivityInput adapter;
// message deltas now flow through the runtime stream bridge and durable
// snapshots through localCanonicalReporter, so this path only persists state.
func (r *localActivityReporter) Report(ctx context.Context, input activity.ReportActivityInput) error {
	for _, patch := range input.StatePatches {
		session := storesqlite.SessionStateReport{
			WorkspaceID: input.WorkspaceID, AgentSessionID: patch.AgentSessionID,
			Kind: patch.Kind, RootAgentSessionID: patch.RootAgentSessionID, RootTurnID: patch.RootTurnID,
			ParentAgentSessionID: patch.ParentAgentSessionID, ParentTurnID: patch.ParentTurnID,
			ParentToolCallID: patch.ParentToolCallID, AgentTargetID: patch.AgentTargetID,
			Provider: patch.Provider, ProviderSessionID: patch.ProviderSessionID, Model: patch.Model,
			Settings: patch.Settings, RuntimeContext: patch.RuntimeContext, Cwd: patch.CWD,
			Title: patch.Title, Status: patch.LifecycleStatus, CurrentPhase: patch.CurrentPhase,
			LastError: patch.LastError, OccurredAtUnixMS: patch.OccurredAtUnixMS,
		}
		state := storesqlite.ActivityStateReport{Session: session}
		if patch.Turn != nil {
			state.Turn = &storesqlite.TurnTransition{
				WorkspaceID: input.WorkspaceID, AgentSessionID: patch.AgentSessionID,
				TurnID: patch.Turn.TurnID, Phase: patch.Turn.Phase, Outcome: patch.Turn.Outcome,
				Origin: patch.Turn.Origin, ErrorCode: patch.Turn.ErrorCode, ErrorMessage: patch.Turn.ErrorMessage,
				FileChanges: patch.Turn.FileChanges, FinalAssistantMessageID: patch.Turn.FinalAssistantMessageID,
				SourceGoalOperationID: patch.Turn.SourceGoalOperationID, SourceGoalRevision: patch.Turn.SourceGoalRevision,
				SourceGoalRepairEpoch: patch.Turn.SourceGoalRepairEpoch, StartedAtUnixMS: patch.Turn.StartedAtUnixMS,
				SettledAtUnixMS: patch.Turn.CompletedAtUnixMS, OccurredAtUnixMS: patch.OccurredAtUnixMS,
			}
		}
		if patch.InteractionTransition != nil {
			state.Interaction = interactionUpsert(input.WorkspaceID, patch.AgentSessionID, patch.InteractionTransition, patch.OccurredAtUnixMS)
		}
		if _, err := r.store.ReportActivityState(ctx, state); err != nil {
			return err
		}
		if r.hub != nil && patch.Turn != nil {
			r.hub.publishActivity(input.WorkspaceID, patch.AgentSessionID, activityEventTurnUpdate,
				turnUpdateEventData(patch.AgentSessionID, patch.Turn, patch.OccurredAtUnixMS))
		}
	}
	return nil
}
func (r *localActivityReporter) ReportSubmitProvenance(ctx context.Context, input activity.ReportActivityInput) error {
	return r.Report(ctx, input)
}

func interactionUpsert(workspaceID, agentSessionID string, transition *canonical.WorkspaceAgentInteractionTransition, occurredAtUnixMS int64) *storesqlite.InteractionUpsert {
	if transition == nil {
		return nil
	}
	return &storesqlite.InteractionUpsert{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
		RequestID: transition.RequestID, TurnID: transition.TurnID,
		Kind: transition.Kind, Status: transition.Status, ToolName: transition.ToolName,
		Input: transition.Input, Metadata: transition.Metadata, OccurredAtUnixMS: occurredAtUnixMS,
	}
}

func (r *localCanonicalReporter) publishInteraction(workspaceID, agentSessionID string, interaction storesqlite.Interaction) {
	r.hub.publish(map[string]any{"topic": "agent.activity.updated", "payload": map[string]any{
		"workspaceId": workspaceID, "agentSessionId": agentSessionID, "eventType": "interaction_update",
		"data": map[string]any{"agentSessionId": agentSessionID, "interaction": interaction},
	}})
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// nonNilSlice keeps empty Go slices JSON-serializable as [] instead of null:
// the activity contract declares authoritative arrays, and clients fail closed
// on null aggregates.
func nonNilSlice[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
