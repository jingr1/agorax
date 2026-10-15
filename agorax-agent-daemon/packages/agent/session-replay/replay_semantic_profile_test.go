package sessionreplay

import (
	"errors"
	"testing"

	agenthost "agorax.local/agent-daemon/packages/agent/host"
)

func TestAgentSemanticProfileRejectsUnsupportedProductDomains(t *testing.T) {
	state := agentOnlyReplayState()
	if err := ValidateAgoraxReplayStateForProfile(state, AgentSemanticProfile()); err != nil {
		t.Fatalf("Agent-only state error = %v", err)
	}

	withInactiveAgoraxMode := state
	withInactiveAgoraxMode.AgoraxMode.TurnSnapshots = []AgoraxReplayTurnSnapshot{{
		SessionID: "session-root", TurnID: "turn-1", State: "inactive",
		DispatchState: "accepted",
	}}
	if err := ValidateAgoraxReplayStateForProfile(
		withInactiveAgoraxMode,
		AgentSemanticProfile(),
	); err != nil {
		t.Fatalf("inactive Agorax Mode snapshot error = %v", err)
	}

	withConfiguredAgoraxMode := state
	withConfiguredAgoraxMode.AgoraxMode.TurnSnapshots = []AgoraxReplayTurnSnapshot{{
		SessionID: "session-root", TurnID: "turn-1",
		ActivationID: "activation-1", RevisionID: "revision-1", Revision: 1,
		State: "inactive", Source: "badge_remove", PreferenceVersion: 1,
		DispatchState: "accepted",
	}}
	if err := ValidateAgoraxReplayStateForProfile(
		withConfiguredAgoraxMode,
		AgentSemanticProfile(),
	); !errors.Is(err, ErrUnsupportedReplaySemanticDomain) {
		t.Fatalf("configured Agorax Mode dependency error = %v", err)
	}

	withWorkflow := state
	withWorkflow.Workflows = []AgoraxReplayWorkflow{{
		ID: "workflow-1", IssueIDs: []string{},
	}}
	if err := ValidateAgoraxReplayStateForProfile(
		withWorkflow,
		AgentSemanticProfile(),
	); !errors.Is(err, ErrUnsupportedReplaySemanticDomain) {
		t.Fatalf("Workflow dependency error = %v", err)
	}
	if err := ValidateAgoraxReplayStateForProfile(
		withWorkflow,
		AgoraxSemanticProfile(),
	); err != nil {
		t.Fatalf("Agorax profile rejected Workflow state: %v", err)
	}
}

func TestAgentSemanticProfileIgnoresInactiveAgoraxModeSnapshots(t *testing.T) {
	withInactiveSnapshot := agentOnlyReplayState()
	withInactiveSnapshot.AgoraxMode.TurnSnapshots = []AgoraxReplayTurnSnapshot{{
		SessionID: "session-root", TurnID: "turn-1", State: "inactive",
		DispatchState: "accepted",
	}}

	merged, err := MergeAgoraxReplayStatesForProfile(
		[]AgoraxReplayState{withInactiveSnapshot},
		AgentSemanticProfile(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.AgoraxMode.TurnSnapshots) != 0 {
		t.Fatalf("merged inactive Agorax Mode snapshots = %#v", merged.AgoraxMode.TurnSnapshots)
	}

	if err := CompareAgoraxReplayStateForProfile(
		withInactiveSnapshot,
		agentOnlyReplayState(),
		AgentSemanticProfile(),
	); err != nil {
		t.Fatalf("compare inactive Agorax Mode snapshot error = %v", err)
	}

	agoraxMerged, err := MergeAgoraxReplayStatesForProfile(
		[]AgoraxReplayState{withInactiveSnapshot},
		AgoraxSemanticProfile(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(agoraxMerged.AgoraxMode.TurnSnapshots) != 1 {
		t.Fatalf("Agorax profile snapshots = %#v", agoraxMerged.AgoraxMode.TurnSnapshots)
	}
	if err := CompareAgoraxReplayStateForProfile(
		withInactiveSnapshot,
		agentOnlyReplayState(),
		AgoraxSemanticProfile(),
	); !errors.Is(err, ErrAgoraxReplayStateConflict) {
		t.Fatalf("Agorax profile snapshot mismatch error = %v", err)
	}
}

func TestSemanticProfileFailsFastOnIndirectIssueDependency(t *testing.T) {
	state := agentOnlyReplayState()
	state.Workflows = []AgoraxReplayWorkflow{{
		ID: "workflow-1", IssueIDs: []string{"issue-1"},
	}}
	profile := SemanticProfile{Agent: true, Workflows: true}
	err := ValidateAgoraxReplayStateForProfile(state, profile)
	if !errors.Is(err, ErrUnsupportedReplaySemanticDomain) {
		t.Fatalf("indirect Issue dependency error = %v", err)
	}
	var unsupported *UnsupportedReplaySemanticDomainError
	if !errors.As(err, &unsupported) || unsupported.Domain != "issues" {
		t.Fatalf("unsupported domain error = %#v", err)
	}
}

func agentOnlyReplayState() AgoraxReplayState {
	return AgoraxReplayState{
		SchemaVersion: SchemaVersion,
		Agent: agenthost.HistoricalSessionGraph{
			RootSessionID: "session-root",
			Sessions: []agenthost.HistoricalSession{{
				ID: "session-root", Kind: "root",
				AgentTargetID: "local:codex", Provider: "codex",
				ProviderSessionID: "provider-session-root",
				Settings:          map[string]any{},
				Turns:             []agenthost.HistoricalTurn{},
				Messages:          []agenthost.HistoricalMessage{},
				Interactions:      []agenthost.HistoricalInteraction{},
			}},
		},
		AgoraxMode: AgoraxReplayAgoraxMode{
			Activations:   []AgoraxReplayActivation{},
			TurnSnapshots: []AgoraxReplayTurnSnapshot{},
		},
		Workflows: []AgoraxReplayWorkflow{},
		Issues:    []AgoraxReplayIssue{},
	}
}
