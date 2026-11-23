package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

// Hermes bridge: Gateway remains the execution surface; daemon agent.db owns
// display-canonical Session/Turn/Message rows (Managed-homologous identity).
// Workspace send-stream reports strong-id Activity here after SSE frames.

type hermesBridgeMessage struct {
	MessageID         string         `json:"messageId"`
	TurnID            string         `json:"turnId"`
	Role              string         `json:"role"`
	Kind              string         `json:"kind"`
	Status            string         `json:"status"`
	Payload           map[string]any `json:"payload"`
	OccurredAtUnixMS  int64          `json:"occurredAtUnixMs"`
	StartedAtUnixMS   int64          `json:"startedAtUnixMs"`
	CompletedAtUnixMS int64          `json:"completedAtUnixMs"`
}

type hermesBridgeActivityRequest struct {
	ProviderSessionID string                `json:"providerSessionId"`
	Title             string                `json:"title"`
	TurnID            string                `json:"turnId"`
	Phase             string                `json:"phase"`
	Outcome           string                `json:"outcome"`
	Messages          []hermesBridgeMessage `json:"messages"`
}

func handleHermesBridgeActivity(store *storesqlite.Store) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if store == nil {
			writeJSON(response, http.StatusServiceUnavailable, map[string]string{
				"error": "canonical store unavailable",
			})
			return
		}
		workspaceID := strings.TrimSpace(request.PathValue("workspaceID"))
		agentSessionID := strings.TrimSpace(request.PathValue("agentSessionID"))
		if workspaceID == "" || agentSessionID == "" {
			writeJSON(response, http.StatusBadRequest, map[string]string{
				"error": "workspaceId and agentSessionId are required",
			})
			return
		}
		var input hermesBridgeActivityRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		now := time.Now().UnixMilli()
		providerSessionID := strings.TrimSpace(input.ProviderSessionID)
		if providerSessionID == "" {
			providerSessionID = agentSessionID
		}
		turnID := strings.TrimSpace(input.TurnID)
		phase := strings.TrimSpace(input.Phase)
		if phase == "" {
			phase = storesqlite.TurnPhaseRunning
		}
		outcome := strings.TrimSpace(input.Outcome)

		if _, err := store.ReportSessionState(request.Context(), storesqlite.SessionStateReport{
			WorkspaceID:       workspaceID,
			AgentSessionID:    agentSessionID,
			AgentTargetID:     "hermes-native",
			Provider:          "hermes",
			ProviderSessionID: providerSessionID,
			Title:             strings.TrimSpace(input.Title),
			Origin:            "runtime",
			OccurredAtUnixMS:  now,
		}); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		if turnID != "" {
			transition := storesqlite.TurnTransition{
				WorkspaceID:      workspaceID,
				AgentSessionID:   agentSessionID,
				TurnID:           turnID,
				Phase:            phase,
				Outcome:          outcome,
				Origin:           storesqlite.TurnOriginUserPrompt,
				OccurredAtUnixMS: now,
				StartedAtUnixMS:  now,
			}
			if phase == storesqlite.TurnPhaseSettled {
				transition.SettledAtUnixMS = now
				if transition.Outcome == "" {
					transition.Outcome = storesqlite.TurnOutcomeCompleted
				}
			}
			if _, _, err := store.RecordTurnTransition(request.Context(), transition); err != nil {
				writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		}

		updates := make([]storesqlite.MessageUpdate, 0, len(input.Messages))
		for _, message := range input.Messages {
			messageID := strings.TrimSpace(message.MessageID)
			if messageID == "" {
				continue
			}
			msgTurn := strings.TrimSpace(message.TurnID)
			if msgTurn == "" {
				msgTurn = turnID
			}
			role := strings.TrimSpace(message.Role)
			if role == "" {
				role = "assistant"
			}
			kind := strings.TrimSpace(message.Kind)
			if kind == "" {
				kind = "text"
			}
			status := strings.TrimSpace(message.Status)
			if status == "" {
				status = "completed"
			}
			occurred := message.OccurredAtUnixMS
			if occurred <= 0 {
				occurred = now
			}
			updates = append(updates, storesqlite.MessageUpdate{
				MessageID:         messageID,
				TurnID:            msgTurn,
				Role:              role,
				Kind:              kind,
				Status:            status,
				Payload:           message.Payload,
				OccurredAtUnixMS:  occurred,
				StartedAtUnixMS:   message.StartedAtUnixMS,
				CompletedAtUnixMS: message.CompletedAtUnixMS,
			})
		}

		latestVersion := uint64(0)
		accepted := 0
		if len(updates) > 0 {
			result, err := store.ReportSessionMessages(request.Context(), storesqlite.SessionMessageReport{
				WorkspaceID:    workspaceID,
				AgentSessionID: agentSessionID,
				Origin:         "runtime",
				Provider:       "hermes",
				Messages:       updates,
			})
			if err != nil {
				writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			latestVersion = result.LatestVersion
			accepted = result.AcceptedCount
		}

		writeJSON(response, http.StatusOK, map[string]any{
			"workspaceId":    workspaceID,
			"agentSessionId": agentSessionID,
			"acceptedCount":  accepted,
			"latestVersion":  latestVersion,
		})
	}
}
