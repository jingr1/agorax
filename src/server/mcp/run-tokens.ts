import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'

export type RunTokenKind = 'read_only' | 'run_write'

/**
 * Tools that mutate run/task state. run_write tokens may carry these in their
 * allowlist; read_only tokens must never contain any of them (enforced at
 * issue time — plan: "read_only 挂在 agent 上…写工具一律 403").
 */
export const WRITE_TOOLS: ReadonlyArray<string> = [
  'task_start',
  'task_complete',
]

export type RunToken = {
  tokenHash: string
  kind: RunTokenKind
  runId: string
  participantId: string
  assignmentId: string | null
  /**
   * Scope id for task tools. Today this column carries the missionId (the
   * plan's P0 mission JSON remains the pipeline source of truth); the column
   * name `task_id` predates that decision. TODO(P1.4): rename / split into
   * an explicit mission_id column on run_tokens.
   */
  taskId: string
  roomId: string | null
  toolAllowlist: Array<string>
  issuedAt: number
  expiresAt: number
  /** null = not revoked. DB stores 0 as the "not revoked" sentinel; we normalise. */
  revokedAt: number | null
  /** Opaque dispatcher-supplied context (P2b git worktree metadata). */
  context?: Record<string, unknown>
}

export type ResolveTokenResult =
  | { ok: true; token: RunToken }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' }

function tokenHashPart(token: string): string {
  // The hashable part is everything before an optional `|` context suffix.
  const bar = token.indexOf('|')
  return bar === -1 ? token : token.slice(0, bar)
}

function parseTokenContext(token: string): Record<string, unknown> | undefined {
  const bar = token.indexOf('|')
  if (bar === -1) return undefined
  try {
    return JSON.parse(
      Buffer.from(token.slice(bar + 1), 'base64url').toString('utf-8'),
    ) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(tokenHashPart(token)).digest('hex')
}

function now(): number {
  return Date.now()
}

export function generateToken(
  kind: RunTokenKind = 'run_write',
  context?: Record<string, unknown>,
): string {
  // Kind prefix is a log/debug affordance only — the DB stores hashes.
  const prefix = kind === 'run_write' ? 'mcp_rw' : 'mcp_ro'
  const randomPart = randomUUID().replace(/-/g, '')
  if (!context || Object.keys(context).length === 0) {
    return `${prefix}_${randomPart}`
  }
  const ctx = Buffer.from(JSON.stringify(context)).toString('base64url')
  return `${prefix}_${randomPart}|${ctx}`
}

export function issueRunToken(input: {
  kind: RunTokenKind
  runId: string
  participantId: string
  assignmentId?: string | null
  taskId: string
  roomId?: string | null
  toolAllowlist: Array<string>
  ttlMs?: number
  dbPath?: string
  /** Opaque dispatcher context carried inside the token string (not in DB). */
  context?: Record<string, unknown>
}): { token: string; tokenHash: string } {
  if (input.kind === 'read_only') {
    const forbidden = input.toolAllowlist.filter((tool) =>
      WRITE_TOOLS.includes(tool),
    )
    if (forbidden.length > 0) {
      throw new Error(
        `read_only token must not allow write tools: ${forbidden.join(', ')}`,
      )
    }
  }
  const dbPath = input.dbPath ?? getCollabDbPath()
  ensureCollabDb(dbPath)
  const token = generateToken(input.kind, input.context)
  const tokenHash = hashToken(token)
  const issuedAt = now()
  const expiresAt = issuedAt + (input.ttlMs ?? 60 * 60 * 1000) // default 1h
  const db = openSqliteDatabase(dbPath, false)
  try {
    db.prepare(
      `
      INSERT INTO run_tokens
      (token_hash, kind, run_id, participant_id, assignment_id, task_id, room_id, tool_allowlist, issued_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `,
    ).run(
      tokenHash,
      input.kind,
      input.runId,
      input.participantId,
      input.assignmentId ?? null,
      input.taskId,
      input.roomId ?? null,
      JSON.stringify(input.toolAllowlist),
      issuedAt,
      expiresAt,
    )
  } finally {
    db.close()
  }
  return { token, tokenHash }
}

export function revokeRunToken(tokenHash: string, dbPath?: string): boolean {
  const path = dbPath ?? getCollabDbPath()
  if (!existsSync(path)) return false
  const db = openSqliteDatabase(path, false)
  try {
    const result = db
      .prepare(
        'UPDATE run_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at = 0',
      )
      .run(now(), tokenHash)
    return result.changes > 0
  } finally {
    db.close()
  }
}

/**
 * Revoke all live tokens bound to a run. Call sites:
 *  - task_complete success (run ends → write token dies with it)
 *  - reassignment: before issuing the new attempt's token, revoke the old
 *    run's tokens (plan: "重派即作废旧 token"). P1.2 dispatcher must call
 *    this; do NOT bypass with a fresh issueRunToken alone.
 */
export function revokeRunTokensForRun(runId: string, dbPath?: string): number {
  const path = dbPath ?? getCollabDbPath()
  if (!existsSync(path)) return 0
  const db = openSqliteDatabase(path, false)
  try {
    const result = db
      .prepare(
        'UPDATE run_tokens SET revoked_at = ? WHERE run_id = ? AND revoked_at = 0',
      )
      .run(now(), runId)
    return result.changes
  } finally {
    db.close()
  }
}

/**
 * Resolve a bearer token. Distinguishes unknown/expired/revoked so the MCP
 * layer can answer with the right error code (-32003/-32004/-32005) instead
 * of a blanket "forbidden" — per plan, failures must tell the agent what to
 * do next.
 */
export function resolveRunTokenDetailed(
  token: string,
  dbPath?: string,
): ResolveTokenResult {
  const path = dbPath ?? getCollabDbPath()
  if (!existsSync(path)) return { ok: false, reason: 'unknown' }
  const tokenHash = hashToken(token)
  const db = openSqliteDatabase(path, true)
  try {
    const rows = db
      .prepare(
        `
      SELECT token_hash, kind, run_id, participant_id, assignment_id, task_id, room_id,
             tool_allowlist, issued_at, expires_at, revoked_at
      FROM run_tokens
      WHERE token_hash = ?
    `,
      )
      .all(tokenHash)
    if (rows.length === 0) return { ok: false, reason: 'unknown' }
    const row = rows[0]
    const revokedAt = Number(row.revoked_at ?? 0)
    if (revokedAt > 0) return { ok: false, reason: 'revoked' }
    if (Number(row.expires_at) <= now()) return { ok: false, reason: 'expired' }
    return {
      ok: true,
      token: {
        tokenHash: String(row.token_hash),
        kind: row.kind as RunTokenKind,
        runId: String(row.run_id),
        participantId: String(row.participant_id),
        assignmentId: row.assignment_id ? String(row.assignment_id) : null,
        taskId: String(row.task_id),
        roomId: row.room_id ? String(row.room_id) : null,
        toolAllowlist: JSON.parse(
          String(row.tool_allowlist ?? '[]'),
        ) as Array<string>,
        issuedAt: Number(row.issued_at),
        expiresAt: Number(row.expires_at),
        revokedAt: null,
        context: parseTokenContext(token),
      },
    }
  } finally {
    db.close()
  }
}

/** Convenience wrapper: returns the token or null (reason collapsed). */
export function resolveRunToken(
  token: string,
  dbPath?: string,
): RunToken | null {
  const result = resolveRunTokenDetailed(token, dbPath)
  return result.ok ? result.token : null
}

/** Pure in-memory allowlist check — no DB access. */
export function isToolAllowed(token: RunToken, toolName: string): boolean {
  return token.toolAllowlist.includes(toolName)
}

/** @deprecated Use isToolAllowed. Kept for call-site compatibility. */
export const assertToolAllowed = isToolAllowed
