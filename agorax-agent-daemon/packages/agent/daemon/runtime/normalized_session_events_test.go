package agentruntime

import "testing"

func TestNormalizedSessionTitleEventConvertsRichTitleOnce(t *testing.T) {
	t.Parallel()

	session := Session{
		RoomID:         "workspace-1",
		AgentSessionID: "session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	}
	event, ok := normalizedSessionTitleEvent(session, map[string]any{
		"title": `[\[inner\]\(literal\)](outer)`,
	})
	if !ok {
		t.Fatal("normalizedSessionTitleEvent() did not emit an event")
	}
	if got := event.Payload.Title; got != `[inner](literal)` {
		t.Fatalf("event title = %q, want one rich-to-plain conversion", got)
	}
}
