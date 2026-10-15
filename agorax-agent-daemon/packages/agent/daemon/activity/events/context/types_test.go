package agentcontext

import "testing"

func TestBuildActivePeersResponseWithKnownSelf(t *testing.T) {
	agents := []Agent{
		{Provider: "codex", ProviderSessionID: "self", EffectiveStatus: "working"},
		{Provider: "claude-code", ProviderSessionID: "other", EffectiveStatus: "working"},
	}
	resp := BuildActivePeersResponse(ActivePeersInput{
		RoomID: "room-1",
		Self:   Identity{Known: true, Provider: "codex", ProviderSessionID: "self"},
		Agents: agents,
	})
	if !resp.OK || !resp.Summary.SelfExcluded || resp.Summary.OtherActiveAgentCount == nil || *resp.Summary.OtherActiveAgentCount != 1 {
		t.Fatalf("unexpected response: %#v", resp)
	}
	if resp.Summary.HasOtherWorkingAgents == nil || !*resp.Summary.HasOtherWorkingAgents {
		t.Fatalf("expected has_other_working_agents=true: %#v", resp.Summary)
	}
	if resp.Agents[0].IsSelf == nil || !*resp.Agents[0].IsSelf {
		t.Fatalf("expected first agent to be self: %#v", resp.Agents[0])
	}
	if resp.Agents[1].IsSelf == nil || *resp.Agents[1].IsSelf {
		t.Fatalf("expected second agent to be other: %#v", resp.Agents[1])
	}
}

func TestBuildActivePeersResponseCountsSameUserDifferentSessionAsOther(t *testing.T) {
	resp := BuildActivePeersResponse(ActivePeersInput{
		RoomID: "room-1",
		Self:   Identity{Known: true, Provider: "codex", ProviderSessionID: "current-session"},
		Agents: []Agent{
			{UserID: "user-1", Provider: "codex", ProviderSessionID: "current-session"},
			{UserID: "user-1", Provider: "codex", ProviderSessionID: "other-session"},
			{UserID: "user-2", Provider: "claude-code", ProviderSessionID: "claude-session"},
		},
	})
	if resp.Summary.OtherActiveAgentCount == nil || *resp.Summary.OtherActiveAgentCount != 2 {
		t.Fatalf("other count = %+v, want 2", resp.Summary.OtherActiveAgentCount)
	}
	if resp.Summary.HasOtherWorkingAgents == nil || !*resp.Summary.HasOtherWorkingAgents {
		t.Fatalf("expected other working agents: %+v", resp.Summary)
	}
	if resp.Agents[1].IsSelf == nil || *resp.Agents[1].IsSelf {
		t.Fatalf("same-user different session should be other: %#v", resp.Agents[1])
	}
}

func TestBuildActivePeersResponseMatchesSelfWhenProviderMissing(t *testing.T) {
	resp := BuildActivePeersResponse(ActivePeersInput{
		RoomID: "room-1",
		Self:   Identity{Known: true, Provider: "codex", ProviderSessionID: "current-session"},
		Agents: []Agent{
			{ProviderSessionID: "current-session", EffectiveStatus: "working"},
			{ProviderSessionID: "other-session", EffectiveStatus: "working"},
		},
	})
	if resp.Summary.OtherActiveAgentCount == nil || *resp.Summary.OtherActiveAgentCount != 1 {
		t.Fatalf("other count = %+v, want 1", resp.Summary.OtherActiveAgentCount)
	}
	if resp.Agents[0].IsSelf == nil || !*resp.Agents[0].IsSelf {
		t.Fatalf("provider-less matching session should be self: %#v", resp.Agents[0])
	}
	if resp.Agents[0].Provider != "codex" {
		t.Fatalf("provider-less self provider = %q, want codex", resp.Agents[0].Provider)
	}
}

func TestBuildActivePeersResponseWithUnknownSelf(t *testing.T) {
	resp := BuildActivePeersResponse(ActivePeersInput{
		RoomID: "room-1",
		Self:   Identity{Known: false},
		Agents: []Agent{{Provider: "codex", ProviderSessionID: "session-1", EffectiveStatus: "working"}},
	})
	if resp.Summary.SelfExcluded {
		t.Fatalf("self should not be excluded when identity is unknown")
	}
	if resp.Summary.OtherActiveAgentCount != nil || resp.Summary.HasOtherWorkingAgents != nil {
		t.Fatalf("other counts must be null when self is unknown: %#v", resp.Summary)
	}
	if len(resp.Warnings) == 0 || resp.Warnings[0].Code != "SELF_IDENTITY_UNAVAILABLE" {
		t.Fatalf("expected self identity warning: %#v", resp.Warnings)
	}
	if resp.Agents[0].IsSelf != nil {
		t.Fatalf("expected self marker to be unknown: %#v", resp.Agents[0])
	}
}
