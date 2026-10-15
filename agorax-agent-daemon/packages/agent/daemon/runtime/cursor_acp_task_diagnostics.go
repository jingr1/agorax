package agentruntime

import (
	"encoding/json"
	"log/slog"
	"strings"

	activityshared "agorax.local/agent-daemon/packages/agent/daemon/activity/events"
)

const cursorACPMethodTask = "cursor/task"

type cursorACPTaskExtensionDiagnostic struct {
	ToolCallID        string
	AgentID           string
	Model             string
	SubagentType      string
	PromptLength      int
	DescriptionLength int
	DurationMS        any
	HasPrompt         bool
	HasDescription    bool
	HasAgentID        bool
	HasDuration       bool
}

func parseCursorACPTaskExtensionDiagnostic(raw json.RawMessage) (cursorACPTaskExtensionDiagnostic, bool) {
	var params map[string]any
	if err := json.Unmarshal(raw, &params); err != nil || params == nil {
		return cursorACPTaskExtensionDiagnostic{}, false
	}
	prompt, promptPresent := params["prompt"].(string)
	description, descriptionPresent := params["description"].(string)
	agentID := strings.TrimSpace(asString(params["agentId"]))
	durationMS, durationPresent := int64Value(params["durationMs"])
	diagnostic := cursorACPTaskExtensionDiagnostic{
		ToolCallID:        strings.TrimSpace(asString(params["toolCallId"])),
		AgentID:           agentID,
		Model:             strings.TrimSpace(asString(params["model"])),
		SubagentType:      cursorACPTaskSubagentTypeLogValue(params["subagentType"]),
		PromptLength:      len(prompt),
		DescriptionLength: len(description),
		DurationMS:        nil,
		HasPrompt:         promptPresent,
		HasDescription:    descriptionPresent,
		HasAgentID:        agentID != "",
		HasDuration:       durationPresent,
	}
	if durationPresent {
		diagnostic.DurationMS = durationMS
	}
	return diagnostic, true
}

func cursorACPTaskSubagentTypeLogValue(value any) string {
	if value := strings.TrimSpace(asString(value)); value != "" {
		return value
	}
	if custom, ok := value.(map[string]any); ok && len(custom) > 0 {
		return "custom"
	}
	return ""
}

func logCursorACPTaskExtension(
	config standardACPConfig,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
) {
	diagnostic, parsed := parseCursorACPTaskExtensionDiagnostic(message.Params)
	slog.Info("agent session Cursor ACP task extension observed",
		"event", "agent_session.cursor.task_extension",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", strings.TrimSpace(turnID),
		"message_id", rawMessageLogValue(message.ID),
		"inside_active_prompt", normalizer != nil && strings.TrimSpace(turnID) != "",
		"params_parsed", parsed,
		"tool_call_id", diagnostic.ToolCallID,
		"has_agent_id", diagnostic.HasAgentID,
		"agent_id", diagnostic.AgentID,
		"subagent_type", diagnostic.SubagentType,
		"model", diagnostic.Model,
		"has_prompt", diagnostic.HasPrompt,
		"prompt_length", diagnostic.PromptLength,
		"has_description", diagnostic.HasDescription,
		"description_length", diagnostic.DescriptionLength,
		"has_duration_ms", diagnostic.HasDuration,
		"duration_ms", diagnostic.DurationMS,
	)
}

func logCursorACPTaskToolUpdate(
	config standardACPConfig,
	session Session,
	turnID string,
	updateType string,
	update map[string]any,
) {
	if !isCursorACPTaskToolUpdate(update) {
		return
	}
	input, _ := acpToolCallRawInput(update).(map[string]any)
	output, _ := acpToolCallRawOutput(update).(map[string]any)
	slog.Info("agent session Cursor ACP task tool update observed",
		"event", "agent_session.cursor.task_tool_update",
		"provider", config.provider,
		"adapter", config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", strings.TrimSpace(turnID),
		"update_type", updateType,
		"tool_call_id", firstNonEmpty(asString(update["toolCallId"]), asString(update["callId"]), asString(update["id"])),
		"raw_status", strings.TrimSpace(asString(update["status"])),
		"resolved_status", acpResolvedToolCallStatus(update, string(activityshared.ActivityStatusRunning)),
		"has_raw_input", len(input) > 0,
		"input_has_agent_id", strings.TrimSpace(asString(input["agentId"])) != "",
		"input_agent_id", strings.TrimSpace(asString(input["agentId"])),
		"input_subagent_type", cursorACPTaskSubagentTypeLogValue(input["subagentType"]),
		"input_model", strings.TrimSpace(asString(input["model"])),
		"input_run_in_background", firstCursorACPBoolLogValue(input, "run_in_background", "runInBackground"),
		"has_raw_output", len(output) > 0,
		"output_is_background", firstCursorACPBoolLogValue(output, "isBackground", "is_background"),
		"output_duration_ms", firstInt64ValueLogValue(output, "durationMs", "duration_ms"),
	)
}

func isCursorACPTaskToolUpdate(update map[string]any) bool {
	input, _ := acpToolCallRawInput(update).(map[string]any)
	if strings.EqualFold(strings.TrimSpace(asString(input["_toolName"])), "task") {
		return true
	}
	title := strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(update["title"]), asString(update["name"]))))
	return title == "task" || strings.HasPrefix(title, "task:")
}

func firstCursorACPBoolLogValue(source map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := source[key].(bool); ok {
			return value
		}
	}
	return nil
}
