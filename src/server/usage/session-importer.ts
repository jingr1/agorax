/**
 * Persist scanned local session records into the workspace usage database.
 *
 * This is the equivalent of cc-switch's session importer path: periodically
 * scan Claude Code / Codex session files and upsert them so the usage
 * aggregator can query them alongside gateway analytics.
 */
import { calculateNormalizedCost } from './pricing-engine'
import { scanClaudeSessions } from './claude-session-scanner'
import { scanCodexSessions } from './codex-session-scanner'
import { withUsageDb } from './usage-db'

function now(): number {
  return Date.now()
}

function upsertClaudeSessions(): void {
  const sessions = scanClaudeSessions()
  withUsageDb((db) => {
    const stmt = db.prepare(
      `INSERT INTO claude_code_sessions (
        session_id, provider_id, agent_id, profile, model, project_dir, title,
        created_at, last_active_at, source_path, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, total_cost_usd, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider_id=excluded.provider_id,
        agent_id=excluded.agent_id,
        profile=excluded.profile,
        model=excluded.model,
        project_dir=excluded.project_dir,
        title=excluded.title,
        created_at=excluded.created_at,
        last_active_at=excluded.last_active_at,
        source_path=excluded.source_path,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        total_cost_usd=excluded.total_cost_usd,
        updated_at=excluded.updated_at`,
    )

    for (const s of sessions) {
      const cost = calculateNormalizedCost({
        providerId: s.providerId,
        modelId: s.model,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheCreationTokens: s.cacheCreationTokens,
      })
      stmt.run(
        s.sessionId,
        s.providerId,
        s.agentId,
        s.profile,
        s.model,
        s.projectDir ?? null,
        s.title ?? null,
        s.createdAt,
        s.lastActiveAt,
        s.sourcePath,
        s.inputTokens,
        s.outputTokens,
        s.cacheReadTokens,
        s.cacheCreationTokens,
        cost.totalCost,
        now(),
      )
    }
  })
}

function upsertCodexSessions(): void {
  const sessions = scanCodexSessions()
  withUsageDb((db) => {
    const stmt = db.prepare(
      `INSERT INTO codex_sessions (
        session_id, provider_id, agent_id, profile, model, title,
        created_at, last_active_at, source_path, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, total_cost_usd, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider_id=excluded.provider_id,
        agent_id=excluded.agent_id,
        profile=excluded.profile,
        model=excluded.model,
        title=excluded.title,
        created_at=excluded.created_at,
        last_active_at=excluded.last_active_at,
        source_path=excluded.source_path,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,
        total_cost_usd=excluded.total_cost_usd,
        updated_at=excluded.updated_at`,
    )

    for (const s of sessions) {
      const cost = calculateNormalizedCost({
        providerId: s.providerId,
        modelId: s.model,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheCreationTokens: s.cacheCreationTokens,
      })
      stmt.run(
        s.sessionId,
        s.providerId,
        s.agentId,
        s.profile,
        s.model,
        s.title ?? null,
        s.createdAt,
        s.lastActiveAt,
        s.sourcePath,
        s.inputTokens,
        s.outputTokens,
        s.cacheReadTokens,
        s.cacheCreationTokens,
        cost.totalCost,
        now(),
      )
    }
  })
}

export function runSessionImporter(): void {
  upsertClaudeSessions()
  upsertCodexSessions()
}
