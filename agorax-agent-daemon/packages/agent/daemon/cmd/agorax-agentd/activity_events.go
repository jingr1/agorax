package main

import (
	"encoding/json"
	"strings"

	activity "agorax.local/agent-daemon/packages/agent/daemon/activity"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

// Stream vocabulary mirrored from the runtime normalizers. Runtime-originated
// nonterminal text/tool snapshots are already delivered as ordered
// message_delta frames by the stream bridge, so the durable message_update
// projection must not repeat them.
const (
	messageContentModeSnapshot  = "snapshot"
	messageStreamStateRunning   = "running"
	messageStreamStateStreaming = "streaming"
	messageStreamStateCompleted = "completed"
	messageStreamStateFailed    = "failed"
)

// turnUpdateEventData builds the turn_update data payload. The turn object is
// the host canonical turn update JSON (WorkspaceAgentTurnStateUpdate or the
// activity WorkspaceAgentTurnPatch — identical wire shapes) plus the session
// identity field the envelope consistency check requires.
func turnUpdateEventData(agentSessionID string, turn any, occurredAtUnixMS int64) map[string]any {
	data := map[string]any{
		"occurredAtUnixMs": occurredAtUnixMS,
		"activeTurnId":     nil,
		"turn":             canonicalTurnPayload(agentSessionID, turn),
	}
	if turnPayload, ok := data["turn"].(map[string]any); ok {
		if activeTurnID, ok := turnPayload["activeTurnId"].(string); ok && strings.TrimSpace(activeTurnID) != "" {
			data["activeTurnId"] = activeTurnID
		}
	}
	return data
}

func canonicalTurnPayload(agentSessionID string, turn any) map[string]any {
	if turn == nil {
		return nil
	}
	encoded, err := json.Marshal(turn)
	if err != nil {
		return nil
	}
	payload := map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return nil
	}
	payload["agentSessionId"] = strings.TrimSpace(agentSessionID)
	return payload
}

// interactionUpdateEventData builds the interaction_update data payload. The
// interaction row serializes PascalCase; the camelCase agentSessionId mirror
// keeps the envelope consistency check satisfied.
func interactionUpdateEventData(interaction storesqlite.Interaction, occurredAtUnixMS int64) map[string]any {
	encoded, err := json.Marshal(interaction)
	if err != nil {
		return nil
	}
	payload := map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return nil
	}
	payload["agentSessionId"] = strings.TrimSpace(interaction.AgentSessionID)
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = interaction.UpdatedAtUnixMS
	}
	return map[string]any{
		"occurredAtUnixMs": occurredAtUnixMS,
		"interaction":      payload,
	}
}

// messageUpdateEventData builds the message_update data payload from the
// committed message snapshots: full versioned messages with their stable
// presentation sequence, plus the accepted-count and latest-version cursors.
func messageUpdateEventData(messages []storesqlite.Message, acceptedCount int, latestVersion uint64) map[string]any {
	return map[string]any{
		"latestVersion": latestVersion,
		"acceptedCount": acceptedCount,
		"messages":      activityMessagesEventPayload(messages),
	}
}

// activityMessagesEventPayload projects committed canonical messages into the
// protocol message shape (upstream Agorax activityMessagesEventPayload).
func activityMessagesEventPayload(messages []storesqlite.Message) []map[string]any {
	if len(messages) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		// Protocol v2: session-level messages carry turnId null, never "".
		var turnID any
		if trimmed := strings.TrimSpace(message.TurnID); trimmed != "" {
			turnID = trimmed
		}
		item := map[string]any{
			"agentSessionId":   strings.TrimSpace(message.AgentSessionID),
			"kind":             strings.TrimSpace(message.Kind),
			"messageId":        strings.TrimSpace(message.MessageID),
			"occurredAtUnixMs": message.OccurredAtUnixMS,
			"payload":          cloneJSONMap(message.Payload),
			"role":             strings.TrimSpace(message.Role),
			"sequence":         message.ID,
			"turnId":           turnID,
			"version":          message.Version,
		}
		if status := strings.TrimSpace(message.Status); status != "" {
			item["status"] = status
		}
		if message.Semantics != nil {
			semantics := map[string]any{"userVisibleAssistantResponse": message.Semantics.UserVisibleAssistantResponse}
			if message.Semantics.TurnSettling {
				semantics["turnSettling"] = true
			}
			if message.Semantics.NoticeCommand != "" {
				semantics["noticeCommand"] = message.Semantics.NoticeCommand
			}
			if message.Semantics.NoticeCommandStatus != "" {
				semantics["noticeCommandStatus"] = message.Semantics.NoticeCommandStatus
			}
			item["semantics"] = semantics
		}
		if message.StartedAtUnixMS > 0 {
			item["startedAtUnixMs"] = message.StartedAtUnixMS
		}
		if message.CompletedAtUnixMS > 0 {
			item["completedAtUnixMs"] = message.CompletedAtUnixMS
		}
		if message.CreatedAtUnixMS > 0 {
			item["createdAtUnixMs"] = message.CreatedAtUnixMS
		}
		if message.UpdatedAtUnixMS > 0 {
			item["updatedAtUnixMs"] = message.UpdatedAtUnixMS
		}
		out = append(out, item)
	}
	return out
}

// canonicalMessagesForRealtimePublish removes only runtime messages whose
// nonterminal state was already emitted as an ordered message_delta frame.
// Storage remains authoritative; terminal, session-level, imported, and
// otherwise non-runtime updates still publish full canonical snapshots
// (upstream Agorax canonicalMessagesForRealtimePublish).
func canonicalMessagesForRealtimePublish(sessionOrigin string, messages []storesqlite.Message) []storesqlite.Message {
	if strings.TrimSpace(sessionOrigin) != activity.WorkspaceAgentSessionOriginRuntime {
		return messages
	}
	filtered := make([]storesqlite.Message, 0, len(messages))
	for _, message := range messages {
		if strings.TrimSpace(message.Kind) == "session_audit" ||
			strings.TrimSpace(message.TurnID) == "" ||
			(!isOptimisticRuntimeTextMessage(message) &&
				!isOptimisticRuntimeToolOutputMessage(message)) {
			filtered = append(filtered, message)
		}
	}
	return filtered
}

func isOptimisticRuntimeTextMessage(message storesqlite.Message) bool {
	switch strings.TrimSpace(message.Kind) {
	case "text", "reasoning":
	default:
		return false
	}
	if strings.TrimSpace(message.Status) != messageStreamStateStreaming {
		return false
	}
	contentMode, _ := message.Payload["contentMode"].(string)
	return strings.TrimSpace(contentMode) == messageContentModeSnapshot
}

func isOptimisticRuntimeToolOutputMessage(message storesqlite.Message) bool {
	if strings.TrimSpace(message.Kind) != "tool_call" {
		return false
	}
	switch strings.TrimSpace(message.Status) {
	case messageStreamStateRunning, messageStreamStateStreaming:
	default:
		return false
	}
	output, _ := message.Payload["output"].(map[string]any)
	text, _ := output["text"].(string)
	return text != ""
}

func cloneJSONMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil
	}
	return out
}
