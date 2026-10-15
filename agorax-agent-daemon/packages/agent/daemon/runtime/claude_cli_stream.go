package agentruntime

import (
	"encoding/json"
	"fmt"
	"strings"
)

// claudeStreamEvent is one normalized fact decoded from a Claude Code
// `--output-format stream-json` NDJSON stdout line. The executor maps these
// onto canonical activity events; the parser intentionally knows nothing
// about the event surface.
type claudeStreamEvent struct {
	kind      string // "init", "text", "thinking", "tool_start", "tool_end", "result", "error"
	sessionID string
	model     string
	text      string
	toolID    string
	toolName  string
	toolInput map[string]any
	toolError bool
	result    claudeStreamResult
	message   string
	// killProcess asks the executor to SIGTERM the CLI immediately. Used for
	// system.api_retry with HTTP 429: Claude Code otherwise burns up to 10
	// exponential backoff retries (minutes) while emitting no assistant text.
	killProcess bool
}

type claudeStreamResult struct {
	subtype      string
	text         string
	isError      bool
	usage        map[string]any
	durationMS   float64
	numTurns     int
	totalCostUSD float64
}

// claudeStreamParser incrementally decodes the NDJSON stream produced by
// `claude -p --output-format stream-json --verbose --include-partial-messages`.
// It mirrors the TypeScript reference parser (claude-stream-json.ts): partial
// message deltas are preferred, and full `assistant` text blocks are skipped
// once any partial text has been seen so the answer is never double-emitted.
type claudeStreamParser struct {
	buffer         string
	sawPartialText bool
	toolsByID      map[string]string
}

func newClaudeStreamParser() *claudeStreamParser {
	return &claudeStreamParser{toolsByID: make(map[string]string)}
}

func (p *claudeStreamParser) push(chunk []byte) []claudeStreamEvent {
	if p == nil || len(chunk) == 0 {
		return nil
	}
	p.buffer += string(chunk)
	var events []claudeStreamEvent
	for {
		newline := strings.IndexByte(p.buffer, '\n')
		if newline < 0 {
			break
		}
		line := p.buffer[:newline]
		p.buffer = p.buffer[newline+1:]
		events = append(events, p.handleLine(strings.TrimSuffix(line, "\r"))...)
	}
	return events
}

// flush decodes a trailing line that was not newline-terminated before the
// process exited.
func (p *claudeStreamParser) flush() []claudeStreamEvent {
	if p == nil || strings.TrimSpace(p.buffer) == "" {
		return nil
	}
	line := strings.TrimSuffix(p.buffer, "\r")
	p.buffer = ""
	return p.handleLine(line)
}

func (p *claudeStreamParser) handleLine(line string) []claudeStreamEvent {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil
	}
	if !strings.HasPrefix(trimmed, "{") {
		// Plain-text fallback (older CLI modes / non-JSON noise).
		return []claudeStreamEvent{{kind: "text", text: line + "\n"}}
	}
	var object map[string]any
	if err := json.Unmarshal([]byte(trimmed), &object); err != nil || object == nil {
		return []claudeStreamEvent{{kind: "text", text: line + "\n"}}
	}
	return p.handleObject(object)
}

func (p *claudeStreamParser) handleObject(object map[string]any) []claudeStreamEvent {
	eventType := asString(object["type"])
	if eventType == "" {
		return nil
	}
	switch eventType {
	case "system":
		return p.handleSystemEvent(object)
	case "assistant":
		return p.handleAssistantMessage(payloadObject(object["message"]))
	case "user":
		return p.handleUserMessage(payloadObject(object["message"]))
	case "stream_event":
		return p.handleStreamEvent(payloadObject(object["event"]))
	case "result":
		return p.handleResult(object)
	case "error":
		return []claudeStreamEvent{{
			kind:    "error",
			message: claudeErrorMessage(object),
		}}
	default:
		return nil
	}
}

func (p *claudeStreamParser) handleSystemEvent(object map[string]any) []claudeStreamEvent {
	switch asString(object["subtype"]) {
	case "init":
		return []claudeStreamEvent{{
			kind:      "init",
			sessionID: strings.TrimSpace(asString(object["session_id"])),
			model:     strings.TrimSpace(asString(object["model"])),
		}}
	case "api_retry":
		// Claude Code retries rate limits internally (max_retries often 10)
		// with growing retry_delay_ms. Gateways that return permanent quota
		// exhaustion as HTTP 429/rate_limit never recover — fail fast so the
		// host surfaces the error instead of hanging until an outer timeout.
		status := claudeInt(object["error_status"])
		errName := strings.TrimSpace(firstNonEmpty(
			asString(object["error"]),
			asString(object["error_status"]),
		))
		if status != 429 && !strings.EqualFold(errName, "rate_limit") {
			return nil
		}
		attempt := claudeInt(object["attempt"])
		maxRetries := claudeInt(object["max_retries"])
		detail := errName
		if detail == "" {
			detail = "rate_limit"
		}
		message := fmt.Sprintf("API Error: Request rejected (%d) · %s", statusOr429(status), detail)
		if attempt > 0 && maxRetries > 0 {
			message = fmt.Sprintf("%s (retry %d/%d aborted)", message, attempt, maxRetries)
		}
		return []claudeStreamEvent{{
			kind:        "error",
			message:     message,
			killProcess: true,
		}}
	default:
		return nil
	}
}

func statusOr429(status int) int {
	if status == 0 {
		return 429
	}
	return status
}

func (p *claudeStreamParser) handleStreamEvent(event map[string]any) []claudeStreamEvent {
	if len(event) == 0 {
		return nil
	}
	switch asString(event["type"]) {
	case "content_block_delta":
		delta := payloadObject(event["delta"])
		if len(delta) == 0 {
			return nil
		}
		switch asString(delta["type"]) {
		case "text_delta":
			text := asString(delta["text"])
			if text == "" {
				return nil
			}
			p.sawPartialText = true
			return []claudeStreamEvent{{kind: "text", text: text}}
		case "thinking_delta":
			text := firstNonEmpty(asString(delta["thinking"]), asString(delta["text"]))
			if text == "" {
				return nil
			}
			return []claudeStreamEvent{{kind: "thinking", text: text}}
		}
		return nil
	case "content_block_start":
		block := payloadObject(event["content_block"])
		if len(block) == 0 {
			return nil
		}
		switch asString(block["type"]) {
		case "tool_use":
			name := firstNonEmpty(asString(block["name"]), "tool")
			id := asString(block["id"])
			if id != "" {
				p.toolsByID[id] = name
			}
			return []claudeStreamEvent{{
				kind:      "tool_start",
				toolID:    id,
				toolName:  name,
				toolInput: clonePayload(payloadObject(block["input"])),
			}}
		case "thinking":
			return []claudeStreamEvent{{kind: "thinking", text: "Thinking…"}}
		}
		return nil
	case "content_block_stop":
		// A tool_use block stop only means its arguments finished streaming;
		// the matching user/tool_result delivers tool completion.
		return nil
	default:
		return nil
	}
}

func (p *claudeStreamParser) handleAssistantMessage(message map[string]any) []claudeStreamEvent {
	content, _ := message["content"].([]any)
	if len(content) == 0 {
		return nil
	}
	var events []claudeStreamEvent
	for _, item := range content {
		block, _ := item.(map[string]any)
		if len(block) == 0 {
			continue
		}
		switch asString(block["type"]) {
		case "text":
			// Partials already streamed this text — skip the duplicate dump.
			if p.sawPartialText {
				continue
			}
			if text := asString(block["text"]); text != "" {
				events = append(events, claudeStreamEvent{kind: "text", text: text})
			}
		case "tool_use":
			name := firstNonEmpty(asString(block["name"]), "tool")
			id := asString(block["id"])
			if id != "" {
				p.toolsByID[id] = name
			}
			events = append(events, claudeStreamEvent{
				kind:      "tool_start",
				toolID:    id,
				toolName:  name,
				toolInput: clonePayload(payloadObject(block["input"])),
			})
		case "thinking":
			if text := firstNonEmpty(asString(block["thinking"]), asString(block["text"])); text != "" {
				events = append(events, claudeStreamEvent{kind: "thinking", text: text})
			}
		}
	}
	return events
}

func (p *claudeStreamParser) handleUserMessage(message map[string]any) []claudeStreamEvent {
	content, _ := message["content"].([]any)
	if len(content) == 0 {
		return nil
	}
	var events []claudeStreamEvent
	for _, item := range content {
		block, _ := item.(map[string]any)
		if len(block) == 0 || asString(block["type"]) != "tool_result" {
			continue
		}
		id := asString(block["tool_use_id"])
		name := p.toolsByID[id]
		if name == "" {
			name = "tool"
		}
		if id != "" {
			delete(p.toolsByID, id)
		}
		events = append(events, claudeStreamEvent{
			kind:      "tool_end",
			toolID:    id,
			toolName:  name,
			toolError: block["is_error"] == true,
			text:      claudeToolResultText(block["content"]),
		})
	}
	return events
}

func (p *claudeStreamParser) handleResult(object map[string]any) []claudeStreamEvent {
	result := claudeStreamResult{
		subtype:      asString(object["subtype"]),
		text:         firstNonEmpty(asString(object["result"]), asString(object["error"])),
		isError:      object["is_error"] == true,
		usage:        clonePayload(payloadObject(object["usage"])),
		durationMS:   claudeFloat(object["duration_ms"]),
		numTurns:     claudeInt(object["num_turns"]),
		totalCostUSD: claudeFloat(object["total_cost_usd"]),
	}
	return []claudeStreamEvent{{kind: "result", result: result}}
}

func claudeErrorMessage(object map[string]any) string {
	switch typed := object["error"].(type) {
	case string:
		if trimmed := strings.TrimSpace(typed); trimmed != "" {
			return trimmed
		}
	case map[string]any:
		if message := firstNonEmpty(asString(typed["message"]), asString(typed["detail"])); message != "" {
			return message
		}
	}
	return firstNonEmpty(asString(object["message"]), "Claude Code run failed")
}

// claudeToolResultText flattens a tool_result content value (string or block
// array) into one bounded plain-text summary for the completed tool card.
func claudeToolResultText(content any) string {
	const maxToolResultChars = 4000
	text := acpContentText(content)
	if text == "" {
		if plain, ok := content.(string); ok {
			text = strings.TrimSpace(plain)
		}
	}
	if len(text) > maxToolResultChars {
		text = text[:maxToolResultChars] + "…"
	}
	return text
}

func claudeFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int64:
		return float64(typed)
	case int:
		return float64(typed)
	default:
		return 0
	}
}

func claudeInt(value any) int {
	return int(claudeFloat(value))
}
