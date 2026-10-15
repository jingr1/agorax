package storesqlite

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSessionInteractionTreeSnapshotIncludesRootAndDescendantLatestTurns(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 1,
	}, "root-turn", 2)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-child",
		Provider: "claude-code", OccurredAtUnixMS: 3,
	}, "child-old", 4)
	seedTreeInteraction(t, store, "child", "child-old", "old-request", InteractionStatusPending, 5)
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-tree", AgentSessionID: "child", TurnID: "child-old",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 6,
	}); err != nil || !accepted {
		t.Fatalf("settle child old turn: accepted=%v err=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-tree", AgentSessionID: "child", TurnID: "child-latest",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 7,
	}); err != nil || !accepted {
		t.Fatalf("start child latest turn: accepted=%v err=%v", accepted, err)
	}
	seedTreeInteraction(t, store, "child", "child-latest", "child-pending", InteractionStatusPending, 8)
	seedTreeInteraction(t, store, "root", "root-turn", "root-answered", InteractionStatusPending, 9)
	seedTreeInteraction(t, store, "root", "root-turn", "root-answered", InteractionStatusAnswered, 10)

	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "nested", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "child", ParentTurnID: "child-latest", ParentToolCallID: "call-nested",
		Provider: "claude-code", OccurredAtUnixMS: 11,
	}, "nested-turn", 12)
	seedTreeInteraction(t, store, "nested", "nested-turn", "nested-pending", InteractionStatusPending, 13)

	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "other-root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 14,
	}, "other-turn", 15)
	seedTreeInteraction(t, store, "other-root", "other-turn", "other-pending", InteractionStatusPending, 16)

	snapshot, found, err := store.GetSessionInteractionTreeSnapshot(ctx, SessionInteractionTreeQuery{
		WorkspaceID: " ws-tree ", RootAgentSessionID: " root ",
	})
	if err != nil || !found {
		t.Fatalf("GetSessionInteractionTreeSnapshot() found=%v err=%v", found, err)
	}
	if snapshot.RootTurnID != "root-turn" {
		t.Fatalf("RootTurnID=%q, want root-turn", snapshot.RootTurnID)
	}
	wantRequests := []string{"child-pending", "nested-pending", "root-answered"}
	if len(snapshot.Interactions) != len(wantRequests) {
		t.Fatalf("Interactions=%#v, want requests %v", snapshot.Interactions, wantRequests)
	}
	for index, want := range wantRequests {
		if snapshot.Interactions[index].RequestID != want {
			t.Fatalf("Interactions[%d]=%#v, want request %q", index, snapshot.Interactions[index], want)
		}
	}
	if len(snapshot.PendingInteractions) != 2 ||
		snapshot.PendingInteractions[0].RequestID != "child-pending" ||
		snapshot.PendingInteractions[1].RequestID != "nested-pending" {
		t.Fatalf("PendingInteractions=%#v", snapshot.PendingInteractions)
	}
}

func TestSessionInteractionTreeSnapshotValidatesExplicitRootTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 1,
	}, "root-turn", 2)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "other-root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 3,
	}, "other-turn", 4)

	for _, turnID := range []string{"missing", "other-turn"} {
		_, _, err := store.GetSessionInteractionTreeSnapshot(context.Background(), SessionInteractionTreeQuery{
			WorkspaceID: "ws-tree", RootAgentSessionID: "root", RootTurnID: turnID,
		})
		if !errors.Is(err, ErrInteractionTreeRootTurnNotFound) {
			t.Fatalf("turn %q error=%v, want %v", turnID, err, ErrInteractionTreeRootTurnNotFound)
		}
	}
	if _, err := store.db.Exec(`
UPDATE workspace_agent_turn_history
SET history_state = 'retracted', retracted_by_operation_id = 'operation-1',
    updated_at_unix_ms = 5
WHERE workspace_id = 'ws-tree' AND agent_session_id = 'root' AND turn_id = 'root-turn'
`); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.GetSessionInteractionTreeSnapshot(context.Background(), SessionInteractionTreeQuery{
		WorkspaceID: "ws-tree", RootAgentSessionID: "root", RootTurnID: "root-turn",
	})
	if !errors.Is(err, ErrInteractionTreeRootTurnNotFound) {
		t.Fatalf("retracted turn error=%v, want %v", err, ErrInteractionTreeRootTurnNotFound)
	}
}

func TestSessionInteractionTreeSnapshotPlanRanksTurnsBeforeJoiningInteractions(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+sessionInteractionTreeSnapshotSQL,
		"ws-tree", "root", "root-turn", "ws-tree", "root", "root-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var details []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		details = append(details, detail)
	}
	plan := strings.Join(details, "\n")
	if strings.Count(plan, "CORRELATED SCALAR SUBQUERY") != 1 ||
		strings.Index(plan, "SCAN ranked_descendant_turns") > strings.Index(plan, "SEARCH interaction") {
		t.Fatalf("interaction tree plan does not rank effective turns before joining interactions:\n%s", plan)
	}
}

func TestInteractionTreeDirtyFactCoversLatestTurnSettleRetractAndDelete(t *testing.T) {
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	ctx := context.Background()
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 1,
	}, "root-turn", 2)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-child",
		Provider: "claude-code", OccurredAtUnixMS: 3,
	}, "child-old", 4)
	seedTreeInteraction(t, store, "child", "child-old", "old-request", InteractionStatusPending, 5)

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-tree", AgentSessionID: "child", TurnID: "child-old",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 6,
	}); err != nil || !accepted {
		t.Fatalf("settle old child turn: accepted=%v err=%v", accepted, err)
	}
	assertLatestInteractionTreeDirty(t, participant, "root", "root-turn")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-tree", AgentSessionID: "child", TurnID: "child-latest",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 7,
	}); err != nil || !accepted {
		t.Fatalf("start latest child turn: accepted=%v err=%v", accepted, err)
	}
	assertLatestInteractionTreeDirty(t, participant, "root", "root-turn")
	seedTreeInteraction(t, store, "child", "child-latest", "latest-request", InteractionStatusPending, 8)

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turn_history
SET history_state = 'retracted', retracted_by_operation_id = 'operation-1', updated_at_unix_ms = 9
WHERE workspace_id = 'ws-tree' AND agent_session_id = 'child' AND turn_id = 'child-latest'
`); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if _, err := store.commitTransaction(ctx, tx, "ws-tree", []TransactionMutation{
		transactionMutation("ws-tree", "child", MutationEntityTurn, "child-latest", "retract", 9),
	}); err != nil {
		t.Fatal(err)
	}
	assertLatestInteractionTreeDirty(t, participant, "root", "root-turn")
	snapshot, found, err := store.GetSessionInteractionTreeSnapshot(ctx, SessionInteractionTreeQuery{
		WorkspaceID: "ws-tree", RootAgentSessionID: "root", RootTurnID: "root-turn",
	})
	if err != nil || !found || len(snapshot.Interactions) != 1 ||
		snapshot.Interactions[0].RequestID != "old-request" {
		t.Fatalf("snapshot after child retract = %#v found=%v err=%v", snapshot, found, err)
	}

	if _, err := store.DeleteSession(ctx, "ws-tree", "child"); err != nil {
		t.Fatal(err)
	}
	assertLatestInteractionTreeDirty(t, participant, "root", "root-turn")
	snapshot, found, err = store.GetSessionInteractionTreeSnapshot(ctx, SessionInteractionTreeQuery{
		WorkspaceID: "ws-tree", RootAgentSessionID: "root", RootTurnID: "root-turn",
	})
	if err != nil || !found || len(snapshot.Interactions) != 0 {
		t.Fatalf("snapshot after child delete = %#v found=%v err=%v", snapshot, found, err)
	}
}

func assertLatestInteractionTreeDirty(
	t *testing.T,
	participant *testTransactionParticipant,
	rootAgentSessionID string,
	rootTurnID string,
) {
	t.Helper()
	if len(participant.deltas) == 0 {
		t.Fatal("interaction tree mutation did not participate")
	}
	for _, mutation := range participant.deltas[len(participant.deltas)-1].Mutations {
		if mutation.EntityKind == MutationEntityInteractionTree &&
			mutation.RootAgentSessionID == rootAgentSessionID && mutation.RootTurnID == rootTurnID {
			return
		}
	}
	t.Fatalf("latest delta lacks interaction tree dirty fact: %#v", participant.deltas[len(participant.deltas)-1])
}

func TestSessionInteractionTreeSnapshotRejectsChildRoot(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "root", Kind: SessionKindRoot,
		Provider: "claude-code", OccurredAtUnixMS: 1,
	}, "root-turn", 2)
	reportSessionWithTurn(t, store, SessionStateReport{
		WorkspaceID: "ws-tree", AgentSessionID: "child", Kind: SessionKindChild,
		RootAgentSessionID: "root", RootTurnID: "root-turn",
		ParentAgentSessionID: "root", ParentTurnID: "root-turn", ParentToolCallID: "call-child",
		Provider: "claude-code", OccurredAtUnixMS: 3,
	}, "child-turn", 4)

	_, _, err := store.GetSessionInteractionTreeSnapshot(context.Background(), SessionInteractionTreeQuery{
		WorkspaceID: "ws-tree", RootAgentSessionID: "child",
	})
	if !errors.Is(err, ErrInteractionTreeRootRequired) {
		t.Fatalf("error=%v, want %v", err, ErrInteractionTreeRootRequired)
	}
}

func seedTreeInteraction(t *testing.T, store *Store, sessionID, turnID, requestID, status string, occurredAt int64) {
	t.Helper()
	_, result, err := store.UpsertInteraction(context.Background(), InteractionUpsert{
		WorkspaceID: "ws-tree", AgentSessionID: sessionID, TurnID: turnID,
		RequestID: requestID, Kind: InteractionKindQuestion, Status: status,
		OccurredAtUnixMS: occurredAt,
	})
	if err != nil || result != InteractionTransitionApplied {
		t.Fatalf("seed interaction %s: result=%v err=%v", requestID, result, err)
	}
}
