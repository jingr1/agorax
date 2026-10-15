package canonical

var canonicalApprovalToolCallKeys = map[string]struct{}{
	"callId":     {},
	"id":         {},
	"input":      {},
	"kind":       {},
	"locations":  {},
	"name":       {},
	"status":     {},
	"title":      {},
	"toolCallId": {},
	"toolName":   {},
}

func compactToolInput(value any) map[string]any {
	body := toolMap(value)
	if body == nil {
		return nil
	}
	for _, rawKey := range []string{"rawInput", "raw_input"} {
		if raw := toolMap(body[rawKey]); len(raw) > 0 {
			body = mergeMissingToolValues(body, raw)
		}
		delete(body, rawKey)
	}
	if toolCall := compactApprovalToolCall(body["toolCall"]); len(toolCall) > 0 {
		body["toolCall"] = toolCall
	} else {
		delete(body, "toolCall")
	}
	return body
}

func compactApprovalToolCall(value any) map[string]any {
	toolCall := toolMap(value)
	if toolCall == nil {
		return nil
	}
	input := compactToolInput(toolCall["input"])
	delete(toolCall, "input")
	toolCall = selectToolKeys(toolCall, canonicalApprovalToolCallKeys)
	if len(input) > 0 {
		toolCall["input"] = input
	}
	return toolCall
}
