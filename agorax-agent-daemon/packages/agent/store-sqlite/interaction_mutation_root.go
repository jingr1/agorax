package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type interactionTreeSessionRoot struct {
	kind               string
	rootAgentSessionID string
	rootTurnID         string
}

const interactionTreeRootLookupBatchSize = 400

// appendInteractionTreeProjectionMutations derives one root-scoped dirty fact
// for every canonical mutation that can change an interaction-tree snapshot.
// Derivation runs inside the caller's write transaction, so destructive paths
// retain the immutable root identity needed by post-commit subscribers.
func appendInteractionTreeProjectionMutations(
	ctx context.Context,
	tx *sql.Tx,
	mutations []TransactionMutation,
) ([]TransactionMutation, error) {
	byWorkspace := make(map[string][]string)
	seen := make(map[string]struct{})
	hasSources := false
	for _, mutation := range mutations {
		if !interactionTreeProjectionSource(mutation) {
			continue
		}
		hasSources = true
		if mutation.RootAgentSessionID != "" {
			continue
		}
		key := mutation.WorkspaceID + "\x00" + mutation.AgentSessionID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		byWorkspace[mutation.WorkspaceID] = append(byWorkspace[mutation.WorkspaceID], mutation.AgentSessionID)
	}
	if !hasSources {
		return mutations, nil
	}

	roots := make(map[string]interactionTreeSessionRoot, len(seen))
	for workspaceID, sessionIDs := range byWorkspace {
		workspaceRoots, err := interactionTreeSessionRootsTx(ctx, tx, workspaceID, sessionIDs)
		if err != nil {
			return nil, err
		}
		for sessionID, root := range workspaceRoots {
			roots[workspaceID+"\x00"+sessionID] = root
		}
	}

	dirtyScopes := make(map[string]struct{})
	result := append([]TransactionMutation(nil), mutations...)
	for _, mutation := range mutations {
		if !interactionTreeProjectionSource(mutation) {
			continue
		}
		rootAgentSessionID := mutation.RootAgentSessionID
		rootTurnID := mutation.RootTurnID
		if rootAgentSessionID == "" {
			root, ok := roots[mutation.WorkspaceID+"\x00"+mutation.AgentSessionID]
			if !ok {
				return nil, fmt.Errorf("interaction tree mutation session %q is missing", mutation.AgentSessionID)
			}
			rootAgentSessionID = root.rootAgentSessionID
			rootTurnID = root.rootTurnID
			if root.kind == SessionKindRoot {
				rootAgentSessionID = mutation.AgentSessionID
				rootTurnID = rootInteractionTreeTurnID(mutation)
			} else if root.kind != SessionKindChild || rootAgentSessionID == "" || rootTurnID == "" {
				return nil, fmt.Errorf("interaction tree mutation session %q has invalid root identity", mutation.AgentSessionID)
			}
		}
		scopeKey := mutation.WorkspaceID + "\x00" + rootAgentSessionID + "\x00" + rootTurnID
		if _, duplicate := dirtyScopes[scopeKey]; duplicate {
			continue
		}
		dirtyScopes[scopeKey] = struct{}{}
		entityID := rootTurnID
		if entityID == "" {
			entityID = rootAgentSessionID
		}
		dirty := transactionMutation(
			mutation.WorkspaceID,
			rootAgentSessionID,
			MutationEntityInteractionTree,
			entityID,
			"dirty",
			mutation.Version,
		)
		dirty.RootAgentSessionID = rootAgentSessionID
		dirty.RootTurnID = rootTurnID
		result = append(result, dirty)
	}
	return result, nil
}

func interactionTreeProjectionSource(mutation TransactionMutation) bool {
	switch mutation.EntityKind {
	case MutationEntityInteraction, MutationEntityTurn:
		return true
	case MutationEntitySession:
		return mutation.Operation == "delete"
	default:
		return false
	}
}

func rootInteractionTreeTurnID(mutation TransactionMutation) string {
	if mutation.EntityKind == MutationEntitySession {
		return ""
	}
	if mutation.EntityKind == MutationEntityTurn {
		return strings.TrimSpace(mutation.EntityID)
	}
	turnID, _, _ := strings.Cut(mutation.EntityID, "\x00")
	return strings.TrimSpace(turnID)
}

// sessionDeleteMutationsTx captures tree scope before a delete path removes or
// tombstones Session rows. The returned source facts can be participated after
// the destructive statements without depending on data that no longer exists.
func sessionDeleteMutationsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
	version int64,
) ([]TransactionMutation, error) {
	mutations := sessionDeleteMutations(workspaceID, sessionIDs, version)
	if len(mutations) == 0 {
		return nil, nil
	}
	roots, err := interactionTreeSessionRootsTx(ctx, tx, workspaceID, sessionIDs)
	if err != nil {
		return nil, err
	}
	for index := range mutations {
		mutation := &mutations[index]
		root, ok := roots[mutation.AgentSessionID]
		if !ok {
			continue
		}
		if root.kind == SessionKindRoot {
			mutation.RootAgentSessionID = mutation.AgentSessionID
			continue
		}
		if root.kind != SessionKindChild || root.rootAgentSessionID == "" || root.rootTurnID == "" {
			return nil, fmt.Errorf("interaction tree delete session %q has invalid root identity", mutation.AgentSessionID)
		}
		mutation.RootAgentSessionID = root.rootAgentSessionID
		mutation.RootTurnID = root.rootTurnID
	}
	return mutations, nil
}

// interactionTreeSessionRootsTx keeps mutation fan-in bounded below SQLite's
// variable limit while retaining indexed point lookups. It is shared by normal
// commits and destructive paths so root-scope derivation has one implementation.
func interactionTreeSessionRootsTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionIDs []string,
) (map[string]interactionTreeSessionRoot, error) {
	roots := make(map[string]interactionTreeSessionRoot, len(sessionIDs))
	for start := 0; start < len(sessionIDs); start += interactionTreeRootLookupBatchSize {
		end := min(start+interactionTreeRootLookupBatchSize, len(sessionIDs))
		batch := sessionIDs[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")
		args := make([]any, 0, len(batch)+1)
		args = append(args, workspaceID)
		for _, sessionID := range batch {
			args = append(args, sessionID)
		}
		rows, err := tx.QueryContext(ctx, `
SELECT agent_session_id, session_kind,
       COALESCE(root_agent_session_id, ''), COALESCE(root_turn_id, '')
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id IN (`+placeholders+`)
`, args...)
		if err != nil {
			return nil, fmt.Errorf("read interaction tree mutation roots: %w", err)
		}
		for rows.Next() {
			var sessionID string
			var root interactionTreeSessionRoot
			if err := rows.Scan(&sessionID, &root.kind, &root.rootAgentSessionID, &root.rootTurnID); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan interaction tree mutation root: %w", err)
			}
			roots[sessionID] = root
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate interaction tree mutation roots: %w", err)
		}
		_ = rows.Close()
	}
	return roots, nil
}
