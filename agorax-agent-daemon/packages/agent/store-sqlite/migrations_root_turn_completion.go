package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentRootTurnCompletionV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentRootTurnCompletionV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent root turn completion v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	columns := []struct{ name, definition string }{
		{"root_provider_turn_id", "TEXT"},
		{"root_provider_turn_phase", "TEXT CHECK (root_provider_turn_phase IS NULL OR root_provider_turn_phase IN ('running','completed'))"},
		{"root_provider_turn_outcome", "TEXT CHECK (root_provider_turn_outcome IS NULL OR root_provider_turn_outcome IN ('completed','failed','canceled','interrupted'))"},
		{"root_provider_turn_error_json", "TEXT"},
		{"root_provider_turn_completed_command_json", "TEXT"},
		{"root_provider_turn_updated_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		exists, err := hasColumnTx(ctx, tx, "workspace_agent_turns", column.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_turns ADD COLUMN `+column.name+` `+column.definition); err != nil {
			return fmt.Errorf("add workspace agent root turn completion column %s: %w", column.name, err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentRootTurnCompletionV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent root turn completion v1: %w", err)
	}
	return nil
}
