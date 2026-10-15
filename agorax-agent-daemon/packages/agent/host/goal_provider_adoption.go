package agenthost

import (
	"context"
	"strings"

	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

const providerGoalAdoptionSource = "provider_goal_adoption"

// AdoptProviderGoal promotes a provider-authored active Goal into the durable
// Host Goal lane without dispatching a second provider mutation.
func (h *Host) AdoptProviderGoal(ctx context.Context, input ProviderGoalAdoptionInput) (ProviderGoalAdoptionResult, error) {
	if h == nil || h.store == nil || h.goals == nil {
		return ProviderGoalAdoptionResult{}, ErrInvalidArgument
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	providerSessionID := strings.TrimSpace(input.ProviderSessionID)
	fingerprint := strings.TrimSpace(input.Fingerprint)
	goal := clonePayload(input.Goal)
	if workspaceID == "" || agentSessionID == "" || providerSessionID == "" || fingerprint == "" ||
		input.ExpectedRevision < 0 ||
		strings.TrimSpace(metadataString(goal, "objective")) == "" ||
		strings.TrimSpace(metadataString(goal, "status")) != "active" {
		return ProviderGoalAdoptionResult{}, ErrInvalidArgument
	}

	var result ProviderGoalAdoptionResult
	err := h.withSessionMutationActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
		canonical, found, err := h.store.GetSession(actorCtx, workspaceID, agentSessionID)
		if err != nil {
			return err
		}
		if !found {
			return ErrSessionNotFound
		}
		if current := strings.TrimSpace(canonical.ProviderSessionID); current != "" && current != providerSessionID {
			return ErrInvalidArgument
		}
		clientSubmitID := strings.Join([]string{providerGoalAdoptionSource, providerSessionID, fingerprint}, ":")
		operationID := goalControlOperationID(workspaceID, agentSessionID, clientSubmitID)
		var operation storesqlite.GoalControlOperation
		var state storesqlite.SessionGoalState
		if err := h.withGoalActor(actorCtx, workspaceID, agentSessionID, func(goalCtx context.Context) error {
			var adoptErr error
			operation, state, _, adoptErr = h.goals.AdoptProviderGoalOperation(goalCtx, storesqlite.ProviderGoalAdoption{
				OperationID: operationID, WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
				ClientSubmitID: clientSubmitID, ExpectedRevision: input.ExpectedRevision, Goal: goal,
				Evidence: map[string]any{
					"source":            providerGoalAdoptionSource,
					"confidence":        "authoritative",
					"providerSessionId": providerSessionID,
					"fingerprint":       fingerprint,
				},
				OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
			})
			return adoptErr
		}); err != nil {
			return err
		}
		result = ProviderGoalAdoptionResult{
			Canonical: canonical, Goal: durableGoalForResponse(state),
			OperationID: operation.OperationID, Revision: operation.GoalRevision,
			RepairEpoch: operation.RepairEpoch,
		}
		return nil
	})
	return result, err
}
