package conformance

import (
	"context"
	"fmt"

	agenthost "agorax.local/agent-daemon/packages/agent/host"
	storesqlite "agorax.local/agent-daemon/packages/agent/store-sqlite"
)

func runInteractionTreeSnapshot(ctx context.Context, driver InteractionTreeDriver) error {
	if err := driver.ResetInteractionTree(ctx); err != nil {
		return err
	}
	snapshot, err := driver.GetSessionInteractionTreeSnapshot(
		ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-tree", AgentSessionID: "session-root"},
		agenthost.SessionInteractionTreeQuery{},
	)
	if err != nil {
		return fmt.Errorf("GetSessionInteractionTreeSnapshot(): %w", err)
	}
	if snapshot.RootTurnID != "turn-root" {
		return fmt.Errorf("root Turn=%q, want turn-root", snapshot.RootTurnID)
	}
	if len(snapshot.Interactions) != 2 ||
		snapshot.Interactions[0].RequestID != "request-child-latest" ||
		snapshot.Interactions[1].RequestID != "request-root" {
		return fmt.Errorf("tree interactions=%#v, want child latest and root", snapshot.Interactions)
	}
	if len(snapshot.PendingInteractions) != 1 ||
		snapshot.PendingInteractions[0].RequestID != "request-child-latest" ||
		snapshot.PendingInteractions[0].Status != storesqlite.InteractionStatusPending {
		return fmt.Errorf("pending tree interactions=%#v, want child latest", snapshot.PendingInteractions)
	}
	return nil
}
