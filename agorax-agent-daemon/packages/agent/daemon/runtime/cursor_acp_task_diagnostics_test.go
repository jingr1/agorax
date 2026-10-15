package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestParseCursorACPTaskExtensionDiagnosticRedactsTaskText(t *testing.T) {
	t.Parallel()

	diagnostic, ok := parseCursorACPTaskExtensionDiagnostic(json.RawMessage(`{
		"toolCallId":"task-call-1",
		"description":"inspect the repository",
		"prompt":"private task instructions",
		"subagentType":"explore",
		"model":"cursor-model",
		"agentId":"child-agent-1",
		"durationMs":1250
	}`))
	if !ok {
		t.Fatal("task extension params were not parsed")
	}
	if diagnostic.ToolCallID != "task-call-1" || diagnostic.AgentID != "child-agent-1" {
		t.Fatalf("diagnostic identity = %#v", diagnostic)
	}
	if diagnostic.SubagentType != "explore" || diagnostic.Model != "cursor-model" {
		t.Fatalf("diagnostic provider fields = %#v", diagnostic)
	}
	if !diagnostic.HasPrompt || diagnostic.PromptLength != len("private task instructions") ||
		!diagnostic.HasDescription || diagnostic.DescriptionLength != len("inspect the repository") {
		t.Fatalf("diagnostic redacted text facts = %#v", diagnostic)
	}
	if !diagnostic.HasAgentID || !diagnostic.HasDuration || diagnostic.DurationMS != int64(1250) {
		t.Fatalf("diagnostic terminal facts = %#v", diagnostic)
	}
}

func TestCursorACPTaskToolUpdateDiagnosticDetection(t *testing.T) {
	t.Parallel()

	if !isCursorACPTaskToolUpdate(map[string]any{
		"rawInput": map[string]any{"_toolName": "task", "run_in_background": true},
	}) {
		t.Fatal("Cursor Task raw input was not detected")
	}
	if !isCursorACPTaskToolUpdate(map[string]any{"title": "Task: Explore repository"}) {
		t.Fatal("Cursor Task title was not detected")
	}
	if isCursorACPTaskToolUpdate(map[string]any{"title": "Shell"}) {
		t.Fatal("ordinary tool was detected as Cursor Task")
	}

	if got := firstCursorACPBoolLogValue(map[string]any{"isBackground": true}, "isBackground"); got != true {
		t.Fatalf("background diagnostic = %#v, want true", got)
	}
}
