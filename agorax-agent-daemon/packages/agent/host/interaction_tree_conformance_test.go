package agenthost_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	agenthost "agorax.local/agent-daemon/packages/agent/host"
	hostconformance "agorax.local/agent-daemon/packages/agent/host/conformance"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func TestInteractionTreeConformance(t *testing.T) {
	for _, scenario := range hostconformance.InteractionTreeScenarios() {
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &sqliteInteractionTreeConformanceDriver{t: t}
			if err := hostconformance.RunInteractionTree(t.Context(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type sqliteInteractionTreeConformanceDriver struct {
	t    *testing.T
	host *agenthost.Host
}

func (d *sqliteInteractionTreeConformanceDriver) ResetInteractionTree(ctx context.Context) error {
	db, err := sql.Open("sqlite", filepath.Join(d.t.TempDir(), "interaction-tree-conformance.db"))
	if err != nil {
		return err
	}
	d.t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(ctx); err != nil {
		return err
	}
	if _, err := store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-tree", AgentSessionID: "session-root",
			Kind: storesqlite.SessionKindRoot, Provider: "claude-code", OccurredAtUnixMS: 1,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-tree", AgentSessionID: "session-root", TurnID: "turn-root",
			Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
		},
	}); err != nil {
		return err
	}
	if _, err := store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-tree", AgentSessionID: "session-child", Kind: storesqlite.SessionKindChild,
			RootAgentSessionID: "session-root", RootTurnID: "turn-root",
			ParentAgentSessionID: "session-root", ParentTurnID: "turn-root", ParentToolCallID: "call-child",
			Provider: "claude-code", OccurredAtUnixMS: 3,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-tree", AgentSessionID: "session-child", TurnID: "turn-child-old",
			Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 4,
		},
	}); err != nil {
		return err
	}
	if _, _, err := store.UpsertInteraction(ctx, storesqlite.InteractionUpsert{
		WorkspaceID: "workspace-tree", AgentSessionID: "session-child", TurnID: "turn-child-old",
		RequestID: "request-child-old", Kind: storesqlite.InteractionKindQuestion,
		Status: storesqlite.InteractionStatusPending, OccurredAtUnixMS: 5,
	}); err != nil {
		return err
	}
	if _, _, err := store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
		WorkspaceID: "workspace-tree", AgentSessionID: "session-child", TurnID: "turn-child-old",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 6,
	}); err != nil {
		return err
	}
	if _, _, err := store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
		WorkspaceID: "workspace-tree", AgentSessionID: "session-child", TurnID: "turn-child-latest",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 7,
	}); err != nil {
		return err
	}
	if _, _, err := store.UpsertInteraction(ctx, storesqlite.InteractionUpsert{
		WorkspaceID: "workspace-tree", AgentSessionID: "session-child", TurnID: "turn-child-latest",
		RequestID: "request-child-latest", Kind: storesqlite.InteractionKindQuestion,
		Status: storesqlite.InteractionStatusPending, OccurredAtUnixMS: 8,
	}); err != nil {
		return err
	}
	if _, _, err := store.UpsertInteraction(ctx, storesqlite.InteractionUpsert{
		WorkspaceID: "workspace-tree", AgentSessionID: "session-root", TurnID: "turn-root",
		RequestID: "request-root", Kind: storesqlite.InteractionKindApproval,
		Status: storesqlite.InteractionStatusPending, OccurredAtUnixMS: 9,
	}); err != nil {
		return err
	}
	if _, _, err := store.UpsertInteraction(ctx, storesqlite.InteractionUpsert{
		WorkspaceID: "workspace-tree", AgentSessionID: "session-root", TurnID: "turn-root",
		RequestID: "request-root", Kind: storesqlite.InteractionKindApproval,
		Status: storesqlite.InteractionStatusAnswered, OccurredAtUnixMS: 10,
	}); err != nil {
		return err
	}
	d.host = agenthost.New(agenthost.Config{CanonicalStore: sqliteCanonicalStore{Store: store}})
	return nil
}

func (d *sqliteInteractionTreeConformanceDriver) GetSessionInteractionTreeSnapshot(
	ctx context.Context,
	ref agenthost.SessionRef,
	query agenthost.SessionInteractionTreeQuery,
) (agenthost.SessionInteractionTreeSnapshot, error) {
	return d.host.GetSessionInteractionTreeSnapshot(ctx, ref, query)
}
