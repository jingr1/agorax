package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

func activeSessionForkSourceOperationTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID string,
) (string, bool, error) {
	var operationID string
	err := tx.QueryRowContext(ctx, `
SELECT operation_id
FROM workspace_agent_session_fork_operations
WHERE workspace_id = ?
  AND source_agent_session_id = ?
  AND status IN ('prepared','dispatching','provider_accepted')
LIMIT 1
`, workspaceID, agentSessionID).Scan(&operationID)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read active session fork source reservation: %w", err)
	}
	return operationID, true, nil
}

// requireSessionForkSourceWritableTx remains as the shared write-path hook, but
// optimistic Fork freezes its own canonical snapshot and never fences source
// activity. Physical cleanup is guarded separately by the retention check in
// requireSessionForkDeleteAllowedTx.
func requireSessionForkSourceWritableTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID, agentSessionID string,
) error {
	_ = ctx
	_ = tx
	_ = workspaceID
	_ = agentSessionID
	return nil
}

func requireSessionForkDeleteAllowedTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	agentSessionIDs []string,
) error {
	for _, agentSessionID := range normalizedSessionIDs(agentSessionIDs) {
		if _, active, err := activeSessionForkSourceOperationTx(
			ctx, tx, workspaceID, agentSessionID,
		); err != nil {
			return err
		} else if active {
			return ErrSessionForkInProgress
		}
		var status string
		err := tx.QueryRowContext(ctx, `
SELECT operation.status
FROM workspace_agent_session_fork_target_reservations reservation
JOIN workspace_agent_session_fork_operations operation
  ON operation.operation_id = reservation.operation_id
WHERE reservation.workspace_id = ?
  AND reservation.target_agent_session_id = ?
`, workspaceID, agentSessionID).Scan(&status)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return fmt.Errorf("read session fork target reservation for delete: %w", err)
		}
		if status != SessionForkStatusCommitted {
			return ErrSessionForkTargetReserved
		}
	}
	return nil
}
