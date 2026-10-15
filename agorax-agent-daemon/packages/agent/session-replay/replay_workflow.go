package sessionreplay

import (
	"context"
	"strings"
)

// PrepareReplayBatch validates and resolves one fixed Cassette batch without
// creating mutable execution state. Product runtime adapters own ephemeral
// replay process identity, progress, and settlement.
func (w *Workflow) PrepareReplayBatch(
	ctx context.Context,
	input PrepareReplayBatchInput,
) (ReplayBatchRequest, error) {
	if len(input.CassetteIDs) == 0 ||
		w.Store == nil || w.Artifacts == nil {
		return ReplayBatchRequest{}, ErrInvalidState
	}

	requests := make([]ReplayRequest, 0, len(input.CassetteIDs))
	cassetteIDs := make(map[string]struct{}, len(input.CassetteIDs))
	rootSessionIDs := make(map[string]struct{}, len(input.CassetteIDs))
	for _, requestedCassetteID := range input.CassetteIDs {
		cassetteID := strings.TrimSpace(requestedCassetteID)
		if cassetteID == "" {
			return ReplayBatchRequest{}, ErrInvalidState
		}
		if _, exists := cassetteIDs[cassetteID]; exists {
			return ReplayBatchRequest{}, ErrInvalidState
		}
		cassetteIDs[cassetteID] = struct{}{}

		cassette, err := w.Store.GetCassette(ctx, cassetteID)
		if err != nil {
			return ReplayBatchRequest{}, err
		}
		rootSessionID := strings.TrimSpace(cassette.RootAgentSessionID)
		if rootSessionID == "" {
			return ReplayBatchRequest{}, ErrInvalidState
		}
		if _, exists := rootSessionIDs[rootSessionID]; exists {
			return ReplayBatchRequest{}, ErrInvalidState
		}
		rootSessionIDs[rootSessionID] = struct{}{}

		artifact, err := w.Artifacts.Resolve(ctx, cassette)
		if err != nil {
			return ReplayBatchRequest{}, err
		}
		if artifact.Cassette.ID != cassette.ID ||
			strings.TrimSpace(artifact.Cassette.RootAgentSessionID) != rootSessionID {
			return ReplayBatchRequest{}, ErrInvalidState
		}
		requests = append(requests, ReplayRequest{
			Cassette: cassette,
			Artifact: artifact,
		})
	}
	return ReplayBatchRequest{Requests: requests}, nil
}

func (w *Workflow) GetCassette(ctx context.Context, cassetteID string) (Cassette, error) {
	if w.Store == nil {
		return Cassette{}, ErrInvalidState
	}
	return w.Store.GetCassette(ctx, strings.TrimSpace(cassetteID))
}
