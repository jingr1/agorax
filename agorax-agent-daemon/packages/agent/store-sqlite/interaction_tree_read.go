package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ErrInteractionTreeRootRequired reports that an interaction-tree query was
// addressed to a child Session. Tree ownership always starts at a root Session.
var ErrInteractionTreeRootRequired = errors.New("interaction tree query requires a root session")

// ErrInteractionTreeRootTurnNotFound reports that an explicitly selected root
// Turn is missing, belongs to another Session, or is retracted.
var ErrInteractionTreeRootTurnNotFound = errors.New("interaction tree root turn was not found")

const sessionInteractionTreeSnapshotSQL = `
WITH descendant_sessions AS (
  SELECT workspace_id, agent_session_id
  FROM workspace_agent_sessions
  WHERE workspace_id = ?
    AND session_kind = 'child'
    AND root_agent_session_id = ?
    AND root_turn_id = ?
    AND deleted_at_unix_ms = 0
),
ranked_descendant_turns AS (
  SELECT turn.workspace_id, turn.agent_session_id, turn.turn_id,
         ROW_NUMBER() OVER (
           PARTITION BY turn.workspace_id, turn.agent_session_id
           ORDER BY turn.updated_at_unix_ms DESC, turn.created_at_unix_ms DESC,
                    turn.started_at_unix_ms DESC, turn.turn_id DESC
         ) AS rank
  FROM workspace_agent_turns turn
  JOIN descendant_sessions session
    ON session.workspace_id = turn.workspace_id
   AND session.agent_session_id = turn.agent_session_id
  WHERE NOT EXISTS (
    SELECT 1 FROM workspace_agent_turn_history history
    WHERE history.workspace_id = turn.workspace_id
      AND history.agent_session_id = turn.agent_session_id
      AND history.turn_id = turn.turn_id
      AND history.history_state = 'retracted'
  )
),
selected_turns AS (
  SELECT ? AS workspace_id, ? AS agent_session_id, ? AS turn_id
  UNION ALL
  SELECT workspace_id, agent_session_id, turn_id
  FROM ranked_descendant_turns
  WHERE rank = 1
)
SELECT interaction.workspace_id,
       interaction.agent_session_id,
       interaction.request_id,
       interaction.turn_id,
       interaction.kind,
       interaction.status,
       interaction.tool_name,
       interaction.input_json,
       interaction.output_json,
       interaction.metadata_json,
       interaction.created_at_unix_ms,
       interaction.updated_at_unix_ms
FROM workspace_agent_interactions interaction
JOIN selected_turns selected
  ON selected.workspace_id = interaction.workspace_id
 AND selected.agent_session_id = interaction.agent_session_id
 AND selected.turn_id = interaction.turn_id
ORDER BY interaction.agent_session_id ASC,
         interaction.turn_id ASC,
         interaction.request_id ASC
`

// GetSessionInteractionTreeSnapshot reads a root Turn and all descendant
// Sessions' latest-Turn interactions from one SQLite snapshot. Descendants are
// selected by their immutable root identity, so traversal depth does not
// affect the query cost.
func (s *Store) GetSessionInteractionTreeSnapshot(
	ctx context.Context,
	query SessionInteractionTreeQuery,
) (SessionInteractionTreeSnapshot, bool, error) {
	if s == nil || s.db == nil {
		return SessionInteractionTreeSnapshot{}, false, errors.New("workspace database is not initialized")
	}
	query.WorkspaceID = strings.TrimSpace(query.WorkspaceID)
	query.RootAgentSessionID = strings.TrimSpace(query.RootAgentSessionID)
	query.RootTurnID = strings.TrimSpace(query.RootTurnID)
	if query.WorkspaceID == "" || query.RootAgentSessionID == "" {
		return SessionInteractionTreeSnapshot{}, false, nil
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("begin interaction tree read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var kind string
	err = tx.QueryRowContext(ctx, `
SELECT session_kind
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, query.WorkspaceID, query.RootAgentSessionID).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionInteractionTreeSnapshot{}, false, nil
	}
	if err != nil {
		return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("read interaction tree root session: %w", err)
	}
	if kind != SessionKindRoot {
		return SessionInteractionTreeSnapshot{}, false, ErrInteractionTreeRootRequired
	}

	rootTurnID := query.RootTurnID
	if rootTurnID != "" {
		var validatedRootTurnID string
		err = tx.QueryRowContext(ctx, `
SELECT turn.turn_id
FROM workspace_agent_turns turn
WHERE turn.workspace_id = ? AND turn.agent_session_id = ? AND turn.turn_id = ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_turn_history history
    WHERE history.workspace_id = turn.workspace_id
      AND history.agent_session_id = turn.agent_session_id
      AND history.turn_id = turn.turn_id
      AND history.history_state = 'retracted'
  )
`, query.WorkspaceID, query.RootAgentSessionID, rootTurnID).Scan(&validatedRootTurnID)
		if errors.Is(err, sql.ErrNoRows) {
			return SessionInteractionTreeSnapshot{}, false, ErrInteractionTreeRootTurnNotFound
		}
		if err != nil {
			return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("validate interaction tree root turn: %w", err)
		}
		rootTurnID = validatedRootTurnID
	} else {
		err = tx.QueryRowContext(ctx, `
SELECT turn_id
FROM workspace_agent_turns turn
WHERE workspace_id = ? AND agent_session_id = ?
  AND NOT EXISTS (
    SELECT 1 FROM workspace_agent_turn_history history
    WHERE history.workspace_id = turn.workspace_id
      AND history.agent_session_id = turn.agent_session_id
      AND history.turn_id = turn.turn_id
      AND history.history_state = 'retracted'
  )
ORDER BY updated_at_unix_ms DESC, created_at_unix_ms DESC,
         started_at_unix_ms DESC, turn_id DESC
LIMIT 1
`, query.WorkspaceID, query.RootAgentSessionID).Scan(&rootTurnID)
		if errors.Is(err, sql.ErrNoRows) {
			return SessionInteractionTreeSnapshot{}, true, nil
		}
		if err != nil {
			return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("resolve interaction tree root turn: %w", err)
		}
	}

	rows, err := tx.QueryContext(ctx, sessionInteractionTreeSnapshotSQL,
		query.WorkspaceID, query.RootAgentSessionID, rootTurnID,
		query.WorkspaceID, query.RootAgentSessionID, rootTurnID)
	if err != nil {
		return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("read interaction tree interactions: %w", err)
	}
	defer rows.Close()

	snapshot := SessionInteractionTreeSnapshot{RootTurnID: rootTurnID}
	for rows.Next() {
		interaction, scanErr := scanAgentInteraction(rows)
		if scanErr != nil {
			return SessionInteractionTreeSnapshot{}, false, scanErr
		}
		snapshot.Interactions = append(snapshot.Interactions, interaction)
		if interaction.Status == InteractionStatusPending {
			snapshot.PendingInteractions = append(snapshot.PendingInteractions, interaction)
		}
	}
	if err := rows.Err(); err != nil {
		return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("iterate interaction tree interactions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return SessionInteractionTreeSnapshot{}, false, fmt.Errorf("finish interaction tree read: %w", err)
	}
	return snapshot, true, nil
}
