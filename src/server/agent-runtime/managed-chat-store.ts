/**
 * SQLite-backed store for managed (non-Hermes) 1:1 chats.
 *
 * Lives in collab.db (same file as group rooms). UI transcript + Claude native
 * session id (--session-id / --resume) are the source of truth — not browser
 * localStorage.
 */
import { randomUUID } from 'node:crypto'
import { ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import type { AgentSession } from '../../lib/agent-types'

export type ManagedChatMessageRow = {
  id: string
  sessionId: string
  role: string
  content: unknown
  isError: boolean
  createdAt: number
}

export type ManagedChatSessionRow = {
  id: string
  agentId: string
  runtime: string
  title: string | null
  agentNativeSessionId: string
  nativeResumeReady: boolean
  model: string | null
  createdAt: number
  updatedAt: number
  messageCount?: number
}

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? getCollabDbPath()
}

function withDb<T>(
  path: string,
  readonly: boolean,
  fn: (db: ReturnType<typeof openSqliteDatabase>) => T,
): T {
  ensureCollabDb(path)
  const db = openSqliteDatabase(path, readonly)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function mapSession(row: Record<string, unknown>): ManagedChatSessionRow {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtime: String(row.runtime ?? 'claude-code'),
    title: row.title == null ? null : String(row.title),
    agentNativeSessionId: String(row.agent_native_session_id ?? ''),
    nativeResumeReady: Number(row.native_resume_ready ?? 0) === 1,
    model: row.model == null ? null : String(row.model),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    messageCount:
      row.message_count == null ? undefined : Number(row.message_count),
  }
}

/** Synthetic session id for group-chat managed member native resume. */
export function roomManagedSessionId(
  roomId: string,
  participantId: string,
): string {
  return `gc:${roomId}:${participantId}`
}

/** Create a brand-new managed chat session row (UI "New Chat"). */
export function createSessionForManagedAgent(
  agentId: string,
  input?: {
    runtime?: string
    title?: string
    model?: string
    dbPath?: string
  },
): { sessionId: string } {
  const sessionId = randomUUID()
  ensureManagedChatSession({
    id: sessionId,
    agentId,
    runtime: input?.runtime ?? 'claude-code',
    title: input?.title,
    model: input?.model,
    dbPath: input?.dbPath,
  })
  return { sessionId }
}

export function ensureManagedChatSession(input: {
  id: string
  agentId: string
  runtime?: string
  title?: string
  model?: string
  dbPath?: string
}): ManagedChatSessionRow {
  const path = dbPath(input)
  const now = Date.now()
  return withDb(path, false, (db) => {
    const existing = db
      .prepare('SELECT * FROM managed_chat_sessions WHERE id = ?')
      .get(input.id) as Record<string, unknown> | undefined
    if (existing) {
      if (input.model?.trim()) {
        db.prepare(
          `UPDATE managed_chat_sessions
           SET model = ?, updated_at = ?
           WHERE id = ?`,
        ).run(input.model.trim(), now, input.id)
      }
      const refreshed = db
        .prepare('SELECT * FROM managed_chat_sessions WHERE id = ?')
        .get(input.id) as Record<string, unknown>
      return mapSession(refreshed)
    }
    db.prepare(
      `INSERT INTO managed_chat_sessions (
         id, agent_id, runtime, title, agent_native_session_id,
         native_resume_ready, model, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', 0, ?, ?, ?)`,
    ).run(
      input.id,
      input.agentId,
      input.runtime ?? 'claude-code',
      input.title?.trim() || null,
      input.model?.trim() || null,
      now,
      now,
    )
    const created = db
      .prepare('SELECT * FROM managed_chat_sessions WHERE id = ?')
      .get(input.id) as Record<string, unknown>
    return mapSession(created)
  })
}

/**
 * Allocate / return Claude native session id for the next spawn.
 * First turn: fresh UUID + resumeReady=false (--session-id).
 * Later turns: stored id + resumeReady=true (--resume).
 */
export function resolveNativeSessionForRun(input: {
  sessionId: string
  dbPath?: string
}): { nativeSessionId: string; resume: boolean } {
  const path = dbPath(input)
  return withDb(path, false, (db) => {
    const row = db
      .prepare('SELECT * FROM managed_chat_sessions WHERE id = ?')
      .get(input.sessionId) as Record<string, unknown> | undefined
    if (!row) {
      throw new Error(`managed chat session not found: ${input.sessionId}`)
    }
    const existing = String(row.agent_native_session_id ?? '').trim()
    const ready = Number(row.native_resume_ready ?? 0) === 1
    if (existing && ready) {
      return { nativeSessionId: existing, resume: true }
    }
    const nativeSessionId = existing || randomUUID()
    if (!existing) {
      db.prepare(
        `UPDATE managed_chat_sessions
         SET agent_native_session_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nativeSessionId, Date.now(), input.sessionId)
    }
    return { nativeSessionId, resume: false }
  })
}

export function recordNativeSessionId(input: {
  sessionId: string
  nativeSessionId: string
  dbPath?: string
}): void {
  const path = dbPath(input)
  const native = input.nativeSessionId.trim()
  if (!native) return
  withDb(path, false, (db) => {
    db.prepare(
      `UPDATE managed_chat_sessions
       SET agent_native_session_id = ?,
           native_resume_ready = 1,
           updated_at = ?
       WHERE id = ?`,
    ).run(native, Date.now(), input.sessionId)
  })
}

export function getManagedChatSession(
  sessionId: string,
  input?: { dbPath?: string },
): ManagedChatSessionRow | null {
  const path = dbPath(input)
  return withDb(path, true, (db) => {
    const row = db
      .prepare('SELECT * FROM managed_chat_sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown> | undefined
    return row ? mapSession(row) : null
  })
}

export function listManagedChatSessions(
  agentId: string,
  input?: { dbPath?: string },
): Array<AgentSession> {
  const path = dbPath(input)
  return withDb(path, true, (db) => {
    const rows = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM managed_chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM managed_chat_sessions s
         WHERE s.agent_id = ?
           AND s.id NOT LIKE 'gc:%'
         ORDER BY s.updated_at DESC`,
      )
      .all(agentId) as Array<Record<string, unknown>>
    return rows.map((row) => {
      const session = mapSession(row)
      const count = session.messageCount ?? 0
      return {
        sessionId: session.id,
        agentId: session.agentId,
        title: session.title?.trim() || 'Chat',
        state: count > 0 ? ('completed' as const) : ('idle' as const),
        lastMessageAt: new Date(session.updatedAt || Date.now()).toISOString(),
        summary: count > 0 ? `Messages: ${count}` : undefined,
      }
    })
  })
}

export function renameManagedChatSession(input: {
  agentId: string
  sessionId: string
  title: string
  dbPath?: string
}): AgentSession | null {
  const trimmed = input.title.trim()
  if (!trimmed) return null
  const path = dbPath(input)
  return withDb(path, false, (db) => {
    const result = db
      .prepare(
        `UPDATE managed_chat_sessions
         SET title = ?, updated_at = ?
         WHERE id = ? AND agent_id = ?`,
      )
      .run(trimmed, Date.now(), input.sessionId, input.agentId)
    if (result.changes === 0) return null
    const row = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM managed_chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM managed_chat_sessions s
         WHERE s.id = ?`,
      )
      .get(input.sessionId) as Record<string, unknown>
    const session = mapSession(row)
    const count = session.messageCount ?? 0
    return {
      sessionId: session.id,
      agentId: session.agentId,
      title: trimmed,
      state: count > 0 ? ('completed' as const) : ('idle' as const),
      lastMessageAt: new Date(session.updatedAt).toISOString(),
      summary: count > 0 ? `Messages: ${count}` : undefined,
    }
  })
}

export function deleteManagedChatSession(input: {
  agentId: string
  sessionId: string
  dbPath?: string
}): boolean {
  const path = dbPath(input)
  return withDb(path, false, (db) => {
    db.prepare(
      'DELETE FROM managed_chat_messages WHERE session_id = ?',
    ).run(input.sessionId)
    const result = db
      .prepare(
        'DELETE FROM managed_chat_sessions WHERE id = ? AND agent_id = ?',
      )
      .run(input.sessionId, input.agentId)
    return result.changes > 0
  })
}

export function listManagedChatMessages(
  sessionId: string,
  input?: { dbPath?: string },
): Array<ManagedChatMessageRow> {
  const path = dbPath(input)
  return withDb(path, true, (db) => {
    const rows = db
      .prepare(
        `SELECT * FROM managed_chat_messages
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as Array<Record<string, unknown>>
    return rows.map((row) => {
      let content: unknown = []
      try {
        content = JSON.parse(String(row.content_json ?? '[]'))
      } catch {
        content = []
      }
      return {
        id: String(row.id),
        sessionId: String(row.session_id),
        role: String(row.role),
        content,
        isError: Number(row.is_error ?? 0) === 1,
        createdAt: Number(row.created_at ?? 0),
      }
    })
  })
}

export function appendManagedChatMessage(input: {
  sessionId: string
  role: string
  content: unknown
  isError?: boolean
  createdAt?: number
  titleFromText?: string
  dbPath?: string
}): ManagedChatMessageRow {
  const path = dbPath(input)
  const id = randomUUID()
  const createdAt = input.createdAt ?? Date.now()
  return withDb(path, false, (db) => {
    db.prepare(
      `INSERT INTO managed_chat_messages (
         id, session_id, role, content_json, is_error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.role,
      JSON.stringify(input.content ?? []),
      input.isError ? 1 : 0,
      createdAt,
    )
    const titleBit = input.titleFromText?.trim()
    if (titleBit) {
      const existing = db
        .prepare('SELECT title FROM managed_chat_sessions WHERE id = ?')
        .get(input.sessionId) as { title: string | null } | undefined
      if (!existing?.title?.trim()) {
        db.prepare(
          `UPDATE managed_chat_sessions
           SET title = ?, updated_at = ?
           WHERE id = ?`,
        ).run(titleBit.slice(0, 60), createdAt, input.sessionId)
      } else {
        db.prepare(
          `UPDATE managed_chat_sessions SET updated_at = ? WHERE id = ?`,
        ).run(createdAt, input.sessionId)
      }
    } else {
      db.prepare(
        `UPDATE managed_chat_sessions SET updated_at = ? WHERE id = ?`,
      ).run(createdAt, input.sessionId)
    }
    return {
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      isError: Boolean(input.isError),
      createdAt,
    }
  })
}

export function clearManagedChatMessages(input: {
  sessionId: string
  dbPath?: string
}): void {
  const path = dbPath(input)
  withDb(path, false, (db) => {
    db.prepare(
      'DELETE FROM managed_chat_messages WHERE session_id = ?',
    ).run(input.sessionId)
    db.prepare(
      `UPDATE managed_chat_sessions SET updated_at = ? WHERE id = ?`,
    ).run(Date.now(), input.sessionId)
  })
}

/** UI ChatMessage shape for the managed chat hook. */
export function messagesToChatPayload(
  rows: Array<ManagedChatMessageRow>,
): Array<{
  role: string
  content: unknown
  isError?: boolean
  timestamp?: number
}> {
  return rows.map((row) => ({
    role: row.role,
    content: row.content,
    ...(row.isError ? { isError: true } : {}),
    timestamp: row.createdAt,
  }))
}
