/**
 * Read Hermes usage from local profile `state.db` files (no Dashboard :9119).
 *
 * Prefer `session_model_usage` when present (per-model billing rows); fall back
 * to the `sessions` table token columns.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { GatewayUsageRecord } from './gateway-analytics-client'

const require = createRequire(import.meta.url)

type SqliteDb = {
  prepare: (sql: string) => {
    all: (...params: Array<unknown>) => Array<Record<string, unknown>>
  }
  close: () => void
}

function hermesRoot(): string {
  return (
    process.env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes')
  )
}

function listProfileStateDbs(): Array<{ profile: string; dbPath: string }> {
  const root = hermesRoot()
  const out: Array<{ profile: string; dbPath: string }> = []
  const defaultDb = path.join(root, 'state.db')
  if (fs.existsSync(defaultDb)) {
    out.push({ profile: 'default', dbPath: defaultDb })
  }
  const profilesDir = path.join(root, 'profiles')
  if (!fs.existsSync(profilesDir)) return out
  for (const name of fs.readdirSync(profilesDir)) {
    if (name.startsWith('.')) continue
    const dbPath = path.join(profilesDir, name, 'state.db')
    if (fs.existsSync(dbPath)) out.push({ profile: name, dbPath })
  }
  return out
}

function openReadonly(dbPath: string): SqliteDb | null {
  try {
    const Database = require('better-sqlite3') as new (
      path: string,
      opts?: Record<string, unknown>,
    ) => SqliteDb
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    try {
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (
          path: string,
          opts?: Record<string, unknown>,
        ) => SqliteDb
      }
      return new DatabaseSync(dbPath, { readOnly: true })
    } catch {
      return null
    }
  }
}

function tableExists(db: SqliteDb, name: string): boolean {
  try {
    const rows = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      )
      .all(name)
    return rows.length > 0
  } catch {
    return false
  }
}

function toMs(ts: unknown): number {
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e11 ? n : n * 1000
}

function readNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function scanDb(
  profile: string,
  dbPath: string,
  sinceMs: number,
): Array<GatewayUsageRecord> {
  const db = openReadonly(dbPath)
  if (!db) return []
  const records: Array<GatewayUsageRecord> = []
  try {
    if (tableExists(db, 'session_model_usage')) {
      const sinceSec = sinceMs / 1000
      const rows = db
        .prepare(
          `SELECT u.*, s.started_at AS session_started_at, s.profile_name AS session_profile
           FROM session_model_usage u
           LEFT JOIN sessions s ON s.id = u.session_id
           WHERE COALESCE(u.last_seen, u.first_seen, s.started_at, 0) >= ?`,
        )
        .all(sinceSec)
      for (const r of rows) {
        const createdAt =
          toMs(r.last_seen) || toMs(r.first_seen) || toMs(r.session_started_at)
        if (createdAt < sinceMs) continue
        records.push({
          request_id: `${r.session_id}:${r.model}:${r.billing_provider}`,
          provider_id: String(r.billing_provider || 'hermes'),
          provider_name: String(r.billing_provider || 'hermes'),
          model: String(r.model || 'unknown'),
          agent_id: 'hermes',
          profile: String(r.session_profile || profile),
          runtime: 'hermes',
          task: String(r.task || '') || undefined,
          input_tokens: readNum(r.input_tokens),
          output_tokens: readNum(r.output_tokens),
          cache_read_tokens: readNum(r.cache_read_tokens),
          cache_creation_tokens: readNum(r.cache_write_tokens),
          reasoning_tokens: readNum(r.reasoning_tokens),
          total_cost_usd: readNum(r.actual_cost_usd) || readNum(r.estimated_cost_usd),
          status_code: 200,
          created_at: createdAt,
        })
      }
      return records
    }

    if (!tableExists(db, 'sessions')) return records
    const sinceSec = sinceMs / 1000
    const rows = db
      .prepare(
        `SELECT id, model, billing_provider, profile_name, started_at, last_activity_at,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                reasoning_tokens, estimated_cost_usd, actual_cost_usd, api_call_count
         FROM sessions
         WHERE COALESCE(last_activity_at, started_at, 0) >= ?`,
      )
      .all(sinceSec)
    for (const r of rows) {
      const createdAt = toMs(r.last_activity_at) || toMs(r.started_at)
      if (createdAt < sinceMs) continue
      records.push({
        request_id: String(r.id),
        provider_id: String(r.billing_provider || 'hermes'),
        provider_name: String(r.billing_provider || 'hermes'),
        model: String(r.model || 'unknown'),
        agent_id: 'hermes',
        profile: String(r.profile_name || profile),
        runtime: 'hermes',
        input_tokens: readNum(r.input_tokens),
        output_tokens: readNum(r.output_tokens),
        cache_read_tokens: readNum(r.cache_read_tokens),
        cache_creation_tokens: readNum(r.cache_write_tokens),
        reasoning_tokens: readNum(r.reasoning_tokens),
        total_cost_usd: readNum(r.actual_cost_usd) || readNum(r.estimated_cost_usd),
        status_code: 200,
        created_at: createdAt,
      })
    }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  return records
}

/** Scan all local Hermes profile DBs for usage since `sinceMs` (epoch ms). */
export function scanHermesSessions(sinceMs: number): Array<GatewayUsageRecord> {
  const out: Array<GatewayUsageRecord> = []
  for (const { profile, dbPath } of listProfileStateDbs()) {
    try {
      out.push(...scanDb(profile, dbPath, sinceMs))
    } catch (err) {
      console.warn(
        `[hermes-session-scanner] ${profile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  return out
}
