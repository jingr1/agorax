package storesqlite

import (
	"context"
	"database/sql"
	"strings"
)

// sessionGoalProjection captures the public canonical Goal fields that may be
// changed as a side effect of accepting a runtime Session report. Observation
// timestamps and evidence remain durability/fencing details and do not wake
// presentation consumers on their own.
type sessionGoalProjection struct {
	found bool
	state SessionGoalState
}

func readSessionGoalProjectionTx(
	ctx context.Context,
	tx *sql.Tx,
	input SessionStateReport,
) (sessionGoalProjection, error) {
	if len(input.RuntimeContext) == 0 {
		return sessionGoalProjection{}, nil
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return sessionGoalProjection{}, nil
	}
	state, found, err := getSessionGoalStateTx(ctx, tx, workspaceID, agentSessionID)
	return sessionGoalProjection{found: found, state: state}, err
}

func sessionGoalMutationsTx(
	ctx context.Context,
	tx *sql.Tx,
	input SessionStateReport,
	before sessionGoalProjection,
) ([]TransactionMutation, error) {
	if len(input.RuntimeContext) == 0 {
		return nil, nil
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	afterState, afterFound, err := getSessionGoalStateTx(ctx, tx, workspaceID, agentSessionID)
	if err != nil || !afterFound || goalProjectionEqual(before, sessionGoalProjection{found: true, state: afterState}) {
		return nil, err
	}

	mutations := []TransactionMutation{
		transactionMutation(
			workspaceID,
			agentSessionID,
			MutationEntityGoalState,
			agentSessionID,
			"reconcile",
			afterState.Revision,
		),
	}
	if !before.found || before.state.PendingOperationID == "" || afterState.PendingOperationID != "" {
		return mutations, nil
	}
	operation, found, err := getGoalControlOperationTx(ctx, tx, workspaceID, before.state.PendingOperationID)
	if err != nil || !found || operation.Status != GoalOperationStatusCompleted {
		return mutations, err
	}
	return append(mutations, transactionMutation(
		workspaceID,
		agentSessionID,
		MutationEntityGoalOperation,
		operation.OperationID,
		"complete",
		operation.UpdatedAtUnixMS,
	)), nil
}

func goalProjectionEqual(left, right sessionGoalProjection) bool {
	if left.found != right.found {
		if left.found {
			return goalProjectionEmpty(left.state)
		}
		return goalProjectionEmpty(right.state)
	}
	if !left.found {
		return true
	}
	return jsonMapsEqual(left.state.Desired, right.state.Desired) &&
		jsonMapsEqual(left.state.Observed, right.state.Observed) &&
		left.state.Revision == right.state.Revision &&
		left.state.Tombstoned == right.state.Tombstoned &&
		left.state.SyncStatus == right.state.SyncStatus &&
		left.state.PendingOperationID == right.state.PendingOperationID &&
		left.state.LastError == right.state.LastError
}

func goalProjectionEmpty(state SessionGoalState) bool {
	return len(state.Desired) == 0 &&
		len(state.Observed) == 0 &&
		state.Revision == 0 &&
		!state.Tombstoned &&
		(state.SyncStatus == "" || state.SyncStatus == GoalSyncStatusUnknown) &&
		state.PendingOperationID == "" &&
		state.LastError == ""
}
