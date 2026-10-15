import * as fs from 'node:fs'
import * as path from 'node:path'
import { getStateDir } from '../workspace-state-dir'
import { openSqliteDatabase, runSqlite, type SqliteDatabase } from '../sqlite-helper'

const USAGE_DB_FILE = 'usage.db'

export function getUsageDbPath(): string {
  const dir = getStateDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, USAGE_DB_FILE)
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_request_logs (
  request_id TEXT PRIMARY KEY,
  agent_id TEXT,
  profile TEXT,
  provider_id TEXT,
  provider_name TEXT,
  model TEXT,
  pricing_model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd TEXT,
  output_cost_usd TEXT,
  cache_read_cost_usd TEXT,
  cache_creation_cost_usd TEXT,
  total_cost_usd TEXT,
  cost_multiplier TEXT DEFAULT '1',
  status_code INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL,
  data_source TEXT DEFAULT 'gateway'
);
CREATE INDEX IF NOT EXISTS idx_workspace_logs_created_at ON workspace_request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_logs_agent ON workspace_request_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_workspace_logs_profile ON workspace_request_logs(profile);
CREATE INDEX IF NOT EXISTS idx_workspace_logs_provider ON workspace_request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_workspace_logs_model ON workspace_request_logs(model);

CREATE TABLE IF NOT EXISTS claude_code_sessions (
  session_id TEXT PRIMARY KEY,
  provider_id TEXT DEFAULT 'claude-code',
  agent_id TEXT DEFAULT 'cc-impl',
  profile TEXT,
  model TEXT,
  project_dir TEXT,
  title TEXT,
  created_at INTEGER,
  last_active_at INTEGER,
  source_path TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_claude_sessions_created ON claude_code_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_claude_sessions_updated ON claude_code_sessions(updated_at);

CREATE TABLE IF NOT EXISTS codex_sessions (
  session_id TEXT PRIMARY KEY,
  provider_id TEXT DEFAULT 'codex',
  agent_id TEXT DEFAULT 'codex-impl',
  profile TEXT,
  model TEXT,
  title TEXT,
  created_at INTEGER,
  last_active_at INTEGER,
  source_path TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_created ON codex_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated ON codex_sessions(updated_at);

CREATE TABLE IF NOT EXISTS usage_rollups (
  date TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  data_source TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd TEXT,
  avg_latency_ms INTEGER,
  PRIMARY KEY (date, agent_id, profile, provider_id, model, data_source)
);
CREATE INDEX IF NOT EXISTS idx_usage_rollups_date ON usage_rollups(date);

CREATE TABLE IF NOT EXISTS usage_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
`

export function initUsageDatabase(): SqliteDatabase {
  const dbPath = getUsageDbPath()
  const db = openSqliteDatabase(dbPath, false)
  db.exec(SCHEMA_SQL)
  return db
}

export function withUsageDb<T>(fn: (db: SqliteDatabase) => T): T {
  const db = initUsageDatabase()
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

export function runUsageSql(sql: string): string {
  return runSqlite(getUsageDbPath(), sql)
}
