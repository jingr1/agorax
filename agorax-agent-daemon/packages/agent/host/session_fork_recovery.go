package agenthost

import (
	"context"
	"errors"
	"fmt"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

const sessionForkRecoveryPageSize = 100

func (h *Host) RecoverSessionForks(ctx context.Context) error {
	if h == nil || h.sessionForks == nil || h.sessionForkRecovery == nil {
		return nil
	}
	var recoveryErrors []error
	handleOperation := func(operation storesqlite.SessionForkOperation) {
		if operation.Status == storesqlite.SessionForkStatusDispatching {
			_, _, err := h.sessionForks.RecordSessionForkProviderResult(
				ctx,
				storesqlite.SessionForkProviderResult{
					WorkspaceID:      operation.WorkspaceID,
					OperationID:      operation.OperationID,
					Status:           storesqlite.SessionForkStatusUnknown,
					LastError:        "provider fork delivery is unknown after restart",
					OccurredAtUnixMS: h.now().UnixMilli(),
				},
			)
			if err != nil {
				recoveryErrors = append(recoveryErrors, err)
			}
			return
		}
		if operation.Status == storesqlite.SessionForkStatusUnknown {
			return
		}
		if _, err := h.processSessionForkOperation(ctx, operation); err != nil &&
			!errors.Is(err, ErrSessionForkDeliveryUnknown) &&
			!errors.Is(err, ErrSessionForkFailed) {
			recoveryErrors = append(recoveryErrors,
				fmt.Errorf("recover session fork %s: %w", operation.OperationID, err))
		}
	}
	cursor := storesqlite.SessionForkRecoveryCursor{}
	for {
		operations, err := h.sessionForkRecovery.ListRecoverableSessionForkOperationsPage(
			ctx, cursor, sessionForkRecoveryPageSize,
		)
		if err != nil {
			return errors.Join(append(recoveryErrors, err)...)
		}
		for _, operation := range operations {
			handleOperation(operation)
		}
		if len(operations) < sessionForkRecoveryPageSize {
			break
		}
		last := operations[len(operations)-1]
		cursor = storesqlite.SessionForkRecoveryCursor{
			CreatedAtUnixMS: last.CreatedAtUnixMS,
			OperationID:     last.OperationID,
		}
	}
	return errors.Join(recoveryErrors...)
}
