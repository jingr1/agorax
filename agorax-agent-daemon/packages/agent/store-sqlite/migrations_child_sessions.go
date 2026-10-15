package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentChildSessionsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentChildSessionsV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent child sessions v1: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	columns := []struct{ name, definition string }{
		{"session_kind", "TEXT NOT NULL DEFAULT 'root' CHECK (session_kind IN ('root','child'))"},
		{"root_agent_session_id", "TEXT"},
		{"root_turn_id", "TEXT"},
		{"parent_agent_session_id", "TEXT"},
		{"parent_turn_id", "TEXT"},
		{"parent_tool_call_id", "TEXT"},
	}
	for _, column := range columns {
		exists, err := hasColumnTx(ctx, tx, "workspace_agent_sessions", column.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN `+column.name+` `+column.definition); err != nil {
			return fmt.Errorf("add workspace agent child session column %s: %w", column.name, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_root
  ON workspace_agent_sessions(workspace_id, root_agent_session_id, root_turn_id, deleted_at_unix_ms);
CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_parent
  ON workspace_agent_sessions(workspace_id, parent_agent_session_id, deleted_at_unix_ms);
CREATE TRIGGER workspace_agent_child_sessions_validate_insert
BEFORE INSERT ON workspace_agent_sessions BEGIN
  SELECT CASE
    WHEN NEW.session_kind = 'root' AND (
      NEW.root_agent_session_id IS NOT NULL OR NEW.root_turn_id IS NOT NULL OR
      NEW.parent_agent_session_id IS NOT NULL OR NEW.parent_turn_id IS NOT NULL OR
      NEW.parent_tool_call_id IS NOT NULL
    ) THEN RAISE(ABORT, 'root session cannot have root or parent fields')
    WHEN NEW.session_kind = 'child' AND (
      NULLIF(TRIM(NEW.root_agent_session_id), '') IS NULL OR
      NULLIF(TRIM(NEW.root_turn_id), '') IS NULL OR
      NULLIF(TRIM(NEW.parent_agent_session_id), '') IS NULL OR
      NULLIF(TRIM(NEW.parent_turn_id), '') IS NULL OR
      NULLIF(TRIM(NEW.parent_tool_call_id), '') IS NULL
    ) THEN RAISE(ABORT, 'child session requires root and parent fields')
    WHEN NEW.session_kind = 'child' AND (
      NEW.root_agent_session_id = NEW.agent_session_id OR
      NEW.parent_agent_session_id = NEW.agent_session_id
    ) THEN RAISE(ABORT, 'child session cannot own or parent itself')
  END;
END;
CREATE TRIGGER workspace_agent_child_sessions_validate_update
BEFORE UPDATE OF session_kind, root_agent_session_id, root_turn_id,
  parent_agent_session_id, parent_turn_id, parent_tool_call_id
ON workspace_agent_sessions BEGIN
  SELECT CASE WHEN
    OLD.session_kind <> NEW.session_kind OR
    IFNULL(OLD.root_agent_session_id, '') <> IFNULL(NEW.root_agent_session_id, '') OR
    IFNULL(OLD.root_turn_id, '') <> IFNULL(NEW.root_turn_id, '') OR
    IFNULL(OLD.parent_agent_session_id, '') <> IFNULL(NEW.parent_agent_session_id, '') OR
    IFNULL(OLD.parent_turn_id, '') <> IFNULL(NEW.parent_turn_id, '') OR
    IFNULL(OLD.parent_tool_call_id, '') <> IFNULL(NEW.parent_tool_call_id, '')
  THEN RAISE(ABORT, 'session root and parent fields are immutable') END;
END;
`); err != nil {
		return fmt.Errorf("create workspace agent child session invariants: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentChildSessionsV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent child sessions v1: %w", err)
	}
	committed = true
	return nil
}
