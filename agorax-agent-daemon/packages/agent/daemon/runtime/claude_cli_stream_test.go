package agentruntime

import (
	"strings"
	"testing"
)

func TestClaudeStreamParserDecodesInitAssistantToolAndResult(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-4-5","tools":["Read"]}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Here is the file."}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/tmp/a.go"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"package main"}]}}`,
		`{"type":"result","subtype":"success","result":"Here is the file.","usage":{"input_tokens":10,"output_tokens":5},"duration_ms":1200,"num_turns":2,"total_cost_usd":0.01}`,
	}
	var events []claudeStreamEvent
	for _, line := range lines {
		events = append(events, parser.push([]byte(line+"\n"))...)
	}

	if len(events) != 5 {
		t.Fatalf("parsed events = %#v, want 5", events)
	}
	if events[0].kind != "init" || events[0].sessionID != "sess-1" || events[0].model != "claude-sonnet-4-5" {
		t.Fatalf("init event = %#v", events[0])
	}
	if events[1].kind != "text" || events[1].text != "Here is the file." {
		t.Fatalf("text event = %#v", events[1])
	}
	if events[2].kind != "tool_start" || events[2].toolID != "toolu_1" || events[2].toolName != "Read" {
		t.Fatalf("tool_start event = %#v", events[2])
	}
	if events[2].toolInput["file_path"] != "/tmp/a.go" {
		t.Fatalf("tool input = %#v", events[2].toolInput)
	}
	if events[3].kind != "tool_end" || events[3].toolID != "toolu_1" || events[3].toolName != "Read" || events[3].toolError {
		t.Fatalf("tool_end event = %#v", events[3])
	}
	if events[3].text != "package main" {
		t.Fatalf("tool output = %q", events[3].text)
	}
	if events[4].kind != "result" || events[4].result.subtype != "success" || events[4].result.text != "Here is the file." {
		t.Fatalf("result event = %#v", events[4])
	}
	if events[4].result.numTurns != 2 || events[4].result.durationMS != 1200 || events[4].result.totalCostUSD != 0.01 {
		t.Fatalf("result stats = %#v", events[4].result)
	}
	if events[4].result.usage["input_tokens"] != float64(10) {
		t.Fatalf("result usage = %#v", events[4].result.usage)
	}
}

func TestClaudeStreamParserPrefersPartialsAndSkipsDuplicatedAssistantText(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	var events []claudeStreamEvent
	events = append(events, parser.push([]byte(
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}`+"\n"+
			`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}`+"\n",
	))...)
	events = append(events, parser.push([]byte(
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}`+"\n",
	))...)

	if len(events) != 2 || events[0].text != "Hel" || events[1].text != "lo" {
		t.Fatalf("events = %#v, want only the two partial deltas", events)
	}
}

func TestClaudeStreamParserToolEndWithoutStartFallsBackToGenericName(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	events := parser.push([]byte(
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok","is_error":true}]}}` + "\n",
	))
	if len(events) != 1 || events[0].kind != "tool_end" || events[0].toolName != "tool" || !events[0].toolError {
		t.Fatalf("events = %#v, want generic failed tool_end", events)
	}
}

func TestClaudeStreamParserChunkBoundariesAndFlush(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	chunk := `{"type":"system","subtype":"init","session_id":"sess-9"}` + "\n" +
		`{"type":"result","subtype":"error","result":"boom"}`
	var events []claudeStreamEvent
	for _, r := range chunk {
		events = append(events, parser.push([]byte(string(r)))...)
	}
	events = append(events, parser.flush()...)
	if len(events) != 2 {
		t.Fatalf("events = %#v, want init + flushed result", events)
	}
	if events[1].kind != "result" || events[1].result.subtype != "error" || events[1].result.text != "boom" {
		t.Fatalf("flushed result = %#v", events[1])
	}
}

func TestClaudeStreamParserPlainTextAndTopLevelErrorFallbacks(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	events := parser.push([]byte("not json at all\n" +
		`{"type":"error","error":{"message":"overloaded","type":"api_error"}}` + "\n" +
		`{"type":"error","error":"plain failure"}` + "\n"))
	if len(events) != 3 {
		t.Fatalf("events = %#v, want 3", events)
	}
	if events[0].kind != "text" || !strings.Contains(events[0].text, "not json") {
		t.Fatalf("plain fallback = %#v", events[0])
	}
	if events[1].kind != "error" || events[1].message != "overloaded" {
		t.Fatalf("object error = %#v", events[1])
	}
	if events[2].kind != "error" || events[2].message != "plain failure" {
		t.Fatalf("string error = %#v", events[2])
	}
}

func TestClaudeStreamParserToolResultTextFlattening(t *testing.T) {
	t.Parallel()

	if text := claudeToolResultText("plain string"); text != "plain string" {
		t.Fatalf("string content = %q", text)
	}
	array := []any{
		map[string]any{"type": "text", "text": "first"},
		map[string]any{"type": "image", "data": "aGk="},
		map[string]any{"type": "text", "text": "second"},
	}
	if text := claudeToolResultText(array); text != "first\nsecond" {
		t.Fatalf("array content = %q", text)
	}
	long := strings.Repeat("x", 5000)
	if text := claudeToolResultText(long); len(text) <= 4000 {
		t.Fatalf("long content was not bounded: %d chars", len(text))
	}
}

func TestClaudeStreamParserFailFastOnAPIRetry429(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	events := parser.push([]byte(
		`{"type":"system","subtype":"init","session_id":"sess-429","model":"DeepSeek-V4-Flash"}` + "\n" +
			`{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":564,"error_status":429,"error":"rate_limit","session_id":"sess-429"}` + "\n",
	))
	if len(events) != 2 {
		t.Fatalf("events = %#v, want init + fatal 429 error", events)
	}
	if events[0].kind != "init" {
		t.Fatalf("first event = %#v, want init", events[0])
	}
	if events[1].kind != "error" || !events[1].killProcess {
		t.Fatalf("second event = %#v, want fatal error", events[1])
	}
	if !strings.Contains(events[1].message, "429") || !strings.Contains(events[1].message, "rate_limit") {
		t.Fatalf("error message = %q", events[1].message)
	}
	if !strings.Contains(events[1].message, "retry 1/10") {
		t.Fatalf("error message missing retry progress: %q", events[1].message)
	}
}

func TestClaudeStreamParserIgnoresNonRateLimitAPIRetry(t *testing.T) {
	t.Parallel()

	parser := newClaudeStreamParser()
	events := parser.push([]byte(
		`{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"error_status":500,"error":"server_error"}` + "\n",
	))
	if len(events) != 0 {
		t.Fatalf("events = %#v, want none for non-429 api_retry", events)
	}
}
