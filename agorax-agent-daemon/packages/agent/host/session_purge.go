package agenthost

import (
	"context"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

// PurgeDeletedSessions permanently removes one bounded batch of canonical
// tombstones. The caller supplies an absolute cutoff; Host deliberately knows
// nothing about retention duration, scheduling, or filesystem cleanup.
func (h *Host) PurgeDeletedSessions(
	ctx context.Context,
	input PurgeDeletedSessionsInput,
) (PurgeDeletedSessionsResult, error) {
	if h == nil || h.sessionPurge == nil || input.CutoffUnixMS <= 0 {
		return PurgeDeletedSessionsResult{}, ErrInvalidArgument
	}
	result, err := h.sessionPurge.PurgeDeletedSessions(ctx, storesqlite.PurgeDeletedSessionsInput{
		CutoffUnixMS: input.CutoffUnixMS, MaxSessions: input.MaxSessions, MaxPayloadBytes: input.MaxPayloadBytes,
	})
	if err != nil {
		return PurgeDeletedSessionsResult{}, err
	}
	return PurgeDeletedSessionsResult{
		Sessions: result.Sessions, RemovedMessages: result.RemovedMessages,
		PayloadBytes: result.PayloadBytes, HasMore: result.HasMore,
	}, nil
}
