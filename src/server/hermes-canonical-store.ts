/**
 * @deprecated Legacy transitional store. Display SoT is daemon agent.db via
 * `hermes-daemon-bridge.ts`. This module remains read-only for migration
 * fallback from early collab.db rows; do not write new turns here.
 */

import type { AgentActivityDurableMessage } from '@agorax/agent-activity-core'
import { ensureCollabDb, getCollabDbPath } from './collab-db'
import { daemonActivityToChatHistory } from './hermes-daemon-bridge'
import { openSqliteDatabase } from './sqlite-helper'

export type HermesCanonicalMessageRow = {
  workspaceId: string
  agentSessionId: string
  messageId: string
  turnId: string | null
  role: string
  kind: string
  status: string
  sequence: number
  version: number
  payload: Record<string, unknown>
  occurredAtUnixMs: number
}

export type HermesCanonicalSessionRow = {
  agentSessionId: string
  workspaceId: string
  profileName: string
  gatewaySessionId: string | null
  title: string | null
  external: boolean
  messageVersion: number
  updatedAtUnixMs: number
}

export type HermesTurnRunIndexRow = {
  agentSessionId: string
  clientSubmitId: string
  turnId: string
  hermesRunId: string | null
  assistantMessageId: string | null
  settledAtUnixMs: number | null
}

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? getCollabDbPath()
}

function ensureDb(input?: { dbPath?: string }): void {
  ensureCollabDb(dbPath(input))
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function ensureHermesCanonicalSession(input: {
  agentSessionId: string
  workspaceId?: string
  profileName?: string
  gatewaySessionId?: string | null
  title?: string | null
  external?: boolean
  dbPath?: string
}): HermesCanonicalSessionRow {
  ensureDb(input)
  const agentSessionId = input.agentSessionId.trim()
  if (!agentSessionId) {
    throw new Error('hermes_canonical_sessions requires agentSessionId')
  }
  const workspaceId = (input.workspaceId ?? 'default').trim() || 'default'
  const profileName = (input.profileName ?? 'default').trim() || 'default'
  const gatewaySessionId = input.gatewaySessionId?.trim() || agentSessionId
  const now = Date.now()
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO hermes_canonical_sessions
         (agent_session_id, workspace_id, profile_name, gateway_session_id, title, external, message_version, updated_at_unix_ms)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(agent_session_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         profile_name = excluded.profile_name,
         gateway_session_id = COALESCE(excluded.gateway_session_id, hermes_canonical_sessions.gateway_session_id),
         title = COALESCE(excluded.title, hermes_canonical_sessions.title),
         external = excluded.external,
         updated_at_unix_ms = excluded.updated_at_unix_ms`,
    ).run(
      agentSessionId,
      workspaceId,
      profileName,
      gatewaySessionId,
      input.title?.trim() || null,
      input.external ? 1 : 0,
      now,
    )
    const row = d
      .prepare(
        `SELECT agent_session_id, workspace_id, profile_name, gateway_session_id, title, external, message_version, updated_at_unix_ms
         FROM hermes_canonical_sessions WHERE agent_session_id = ?`,
      )
      .get(agentSessionId) as Record<string, unknown> | undefined
    if (!row) {
      throw new Error('hermes_canonical_sessions upsert failed')
    }
    return {
      agentSessionId: String(row.agent_session_id),
      workspaceId: String(row.workspace_id),
      profileName: String(row.profile_name),
      gatewaySessionId:
        typeof row.gateway_session_id === 'string'
          ? row.gateway_session_id
          : null,
      title: typeof row.title === 'string' ? row.title : null,
      external: Number(row.external) === 1,
      messageVersion: Number(row.message_version) || 0,
      updatedAtUnixMs: Number(row.updated_at_unix_ms) || now,
    }
  } finally {
    d.close()
  }
}

export function upsertHermesTurnRunIndex(input: {
  agentSessionId: string
  clientSubmitId: string
  turnId: string
  hermesRunId?: string | null
  assistantMessageId?: string | null
  settledAtUnixMs?: number | null
  dbPath?: string
}): HermesTurnRunIndexRow {
  ensureDb(input)
  const agentSessionId = input.agentSessionId.trim()
  const clientSubmitId = input.clientSubmitId.trim()
  const turnId = input.turnId.trim() || `turn-${clientSubmitId}`
  if (!agentSessionId || !clientSubmitId) {
    throw new Error('hermes_turn_run_index requires agentSessionId + clientSubmitId')
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO hermes_turn_run_index
         (agent_session_id, client_submit_id, turn_id, hermes_run_id, assistant_message_id, settled_at_unix_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_session_id, client_submit_id) DO UPDATE SET
         turn_id = excluded.turn_id,
         hermes_run_id = COALESCE(excluded.hermes_run_id, hermes_turn_run_index.hermes_run_id),
         assistant_message_id = COALESCE(excluded.assistant_message_id, hermes_turn_run_index.assistant_message_id),
         settled_at_unix_ms = COALESCE(excluded.settled_at_unix_ms, hermes_turn_run_index.settled_at_unix_ms)`,
    ).run(
      agentSessionId,
      clientSubmitId,
      turnId,
      input.hermesRunId?.trim() || null,
      input.assistantMessageId?.trim() || null,
      input.settledAtUnixMs ?? null,
    )
    return {
      agentSessionId,
      clientSubmitId,
      turnId,
      hermesRunId: input.hermesRunId?.trim() || null,
      assistantMessageId: input.assistantMessageId?.trim() || null,
      settledAtUnixMs: input.settledAtUnixMs ?? null,
    }
  } finally {
    d.close()
  }
}

export function getHermesTurnRunBySubmitId(input: {
  agentSessionId: string
  clientSubmitId: string
  dbPath?: string
}): HermesTurnRunIndexRow | null {
  ensureDb(input)
  const agentSessionId = input.agentSessionId.trim()
  const clientSubmitId = input.clientSubmitId.trim()
  if (!agentSessionId || !clientSubmitId) return null
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const row = d
      .prepare(
        `SELECT agent_session_id, client_submit_id, turn_id, hermes_run_id, assistant_message_id, settled_at_unix_ms
         FROM hermes_turn_run_index
         WHERE agent_session_id = ? AND client_submit_id = ?`,
      )
      .get(agentSessionId, clientSubmitId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      agentSessionId: String(row.agent_session_id),
      clientSubmitId: String(row.client_submit_id),
      turnId: String(row.turn_id),
      hermesRunId:
        typeof row.hermes_run_id === 'string' ? row.hermes_run_id : null,
      assistantMessageId:
        typeof row.assistant_message_id === 'string'
          ? row.assistant_message_id
          : null,
      settledAtUnixMs:
        typeof row.settled_at_unix_ms === 'number'
          ? row.settled_at_unix_ms
          : null,
    }
  } finally {
    d.close()
  }
}

/**
 * Upsert one Activity-shaped message. Version is monotonic per session.
 * Same messageId replaces payload (Managed/Tutti homology).
 */
export function upsertHermesCanonicalMessage(input: {
  workspaceId?: string
  agentSessionId: string
  messageId: string
  turnId?: string | null
  role: string
  kind?: string
  status?: string
  payload?: Record<string, unknown>
  occurredAtUnixMs?: number
  profileName?: string
  gatewaySessionId?: string | null
  dbPath?: string
}): HermesCanonicalMessageRow {
  ensureDb(input)
  const agentSessionId = input.agentSessionId.trim()
  const messageId = input.messageId.trim()
  if (!agentSessionId || !messageId) {
    throw new Error('hermes_canonical_messages requires agentSessionId + messageId')
  }
  const workspaceId = (input.workspaceId ?? 'default').trim() || 'default'
  ensureHermesCanonicalSession({
    agentSessionId,
    workspaceId,
    profileName: input.profileName,
    gatewaySessionId: input.gatewaySessionId ?? agentSessionId,
    dbPath: input.dbPath,
  })
  const occurredAtUnixMs =
    typeof input.occurredAtUnixMs === 'number' &&
    Number.isFinite(input.occurredAtUnixMs) &&
    input.occurredAtUnixMs > 0
      ? input.occurredAtUnixMs
      : Date.now()
  const payload = input.payload ?? {}
  const role = input.role.trim() || 'assistant'
  const kind = (input.kind ?? 'text').trim() || 'text'
  const status = (input.status ?? 'completed').trim() || 'completed'
  const turnId = input.turnId?.trim() || null
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    const existing = d
      .prepare(
        `SELECT sequence, version FROM hermes_canonical_messages
         WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ?`,
      )
      .get(workspaceId, agentSessionId, messageId) as
      | { sequence: number; version: number }
      | undefined

    d.prepare(
      `UPDATE hermes_canonical_sessions
       SET message_version = message_version + 1, updated_at_unix_ms = ?
       WHERE agent_session_id = ?`,
    ).run(occurredAtUnixMs, agentSessionId)
    const bumped = d
      .prepare(
        `SELECT message_version FROM hermes_canonical_sessions WHERE agent_session_id = ?`,
      )
      .get(agentSessionId) as { message_version?: number } | undefined
    const version = Number(bumped?.message_version) || 1
    let sequence: number
    if (existing) {
      sequence = Number(existing.sequence)
      d.prepare(
        `UPDATE hermes_canonical_messages SET
           turn_id = COALESCE(?, turn_id),
           role = ?,
           kind = ?,
           status = ?,
           version = ?,
           payload_json = ?,
           occurred_at_unix_ms = ?
         WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ?`,
      ).run(
        turnId,
        role,
        kind,
        status,
        version,
        JSON.stringify(payload),
        occurredAtUnixMs,
        workspaceId,
        agentSessionId,
        messageId,
      )
    } else {
      sequence = version
      d.prepare(
        `INSERT INTO hermes_canonical_messages
           (workspace_id, agent_session_id, message_id, turn_id, role, kind, status,
            sequence, version, payload_json, occurred_at_unix_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        workspaceId,
        agentSessionId,
        messageId,
        turnId,
        role,
        kind,
        status,
        sequence,
        version,
        JSON.stringify(payload),
        occurredAtUnixMs,
      )
    }

    return {
      workspaceId,
      agentSessionId,
      messageId,
      turnId,
      role,
      kind,
      status,
      sequence,
      version,
      payload,
      occurredAtUnixMs,
    }
  } finally {
    d.close()
  }
}

export function listHermesCanonicalMessages(input: {
  agentSessionId: string
  workspaceId?: string
  afterVersion?: number
  limit?: number
  dbPath?: string
}): {
  messages: Array<HermesCanonicalMessageRow>
  latestVersion: number
  hasMore: boolean
} {
  ensureDb(input)
  const agentSessionId = input.agentSessionId.trim()
  if (!agentSessionId) {
    return { messages: [], latestVersion: 0, hasMore: false }
  }
  const workspaceId = (input.workspaceId ?? 'default').trim() || 'default'
  const afterVersion =
    typeof input.afterVersion === 'number' && input.afterVersion > 0
      ? input.afterVersion
      : 0
  const limit =
    typeof input.limit === 'number' && input.limit > 0
      ? Math.min(input.limit, 1000)
      : 1000
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const session = d
      .prepare(
        `SELECT message_version FROM hermes_canonical_sessions WHERE agent_session_id = ?`,
      )
      .get(agentSessionId) as { message_version?: number } | undefined
    const latestVersion = Number(session?.message_version) || 0
    const rows = d
      .prepare(
        `SELECT workspace_id, agent_session_id, message_id, turn_id, role, kind, status,
                sequence, version, payload_json, occurred_at_unix_ms
         FROM hermes_canonical_messages
         WHERE workspace_id = ? AND agent_session_id = ? AND version > ?
         ORDER BY sequence ASC, version ASC
         LIMIT ?`,
      )
      .all(workspaceId, agentSessionId, afterVersion, limit + 1) as Array<
      Record<string, unknown>
    >
    const hasMore = rows.length > limit
    const sliced = hasMore ? rows.slice(0, limit) : rows
    return {
      latestVersion,
      hasMore,
      messages: sliced.map((row) => ({
        workspaceId: String(row.workspace_id),
        agentSessionId: String(row.agent_session_id),
        messageId: String(row.message_id),
        turnId: typeof row.turn_id === 'string' ? row.turn_id : null,
        role: String(row.role),
        kind: String(row.kind),
        status: String(row.status),
        sequence: Number(row.sequence) || 0,
        version: Number(row.version) || 0,
        payload: parsePayload(row.payload_json),
        occurredAtUnixMs: Number(row.occurred_at_unix_ms) || 0,
      })),
    }
  } finally {
    d.close()
  }
}

export function hasHermesCanonicalMessages(input: {
  agentSessionId: string
  dbPath?: string
}): boolean {
  ensureDb(input)
  const agentSessionId = input.agentSessionId.trim()
  if (!agentSessionId) return false
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const row = d
      .prepare(
        `SELECT 1 AS ok FROM hermes_canonical_messages
         WHERE agent_session_id = ? LIMIT 1`,
      )
      .get(agentSessionId) as { ok?: number } | undefined
    return Boolean(row)
  } finally {
    d.close()
  }
}

export function listHermesCanonicalSessions(input?: {
  profileName?: string
  limit?: number
  dbPath?: string
}): Array<HermesCanonicalSessionRow> {
  ensureDb(input)
  const profileName = input?.profileName?.trim()
  const limit =
    typeof input?.limit === 'number' && input.limit > 0
      ? Math.min(input.limit, 500)
      : 100
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = (
      profileName
        ? d
            .prepare(
              `SELECT agent_session_id, workspace_id, profile_name, gateway_session_id, title, external, message_version, updated_at_unix_ms
               FROM hermes_canonical_sessions
               WHERE profile_name = ?
               ORDER BY updated_at_unix_ms DESC
               LIMIT ?`,
            )
            .all(profileName, limit)
        : d
            .prepare(
              `SELECT agent_session_id, workspace_id, profile_name, gateway_session_id, title, external, message_version, updated_at_unix_ms
               FROM hermes_canonical_sessions
               ORDER BY updated_at_unix_ms DESC
               LIMIT ?`,
            )
            .all(limit)
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      agentSessionId: String(row.agent_session_id),
      workspaceId: String(row.workspace_id),
      profileName: String(row.profile_name),
      gatewaySessionId:
        typeof row.gateway_session_id === 'string'
          ? row.gateway_session_id
          : null,
      title: typeof row.title === 'string' ? row.title : null,
      external: Number(row.external) === 1,
      messageVersion: Number(row.message_version) || 0,
      updatedAtUnixMs: Number(row.updated_at_unix_ms) || 0,
    }))
  } finally {
    d.close()
  }
}

/** Project canonical rows to ChatMessage-shaped history for /api/history. */
export function hermesCanonicalMessagesToChatHistory(
  messages: readonly HermesCanonicalMessageRow[],
): Array<Record<string, unknown>> {
  // Same fold contract as daemonActivityToChatHistory (legacy collab fallback).
  return daemonActivityToChatHistory(
    messages.map(
      (row): AgentActivityDurableMessage => ({
        workspaceId: row.workspaceId,
        agentSessionId: row.agentSessionId,
        messageId: row.messageId,
        turnId: row.turnId,
        role: row.role,
        kind: row.kind,
        status: row.status,
        payload: row.payload,
        sequence: row.sequence,
        version: row.version,
        occurredAtUnixMs: row.occurredAtUnixMs,
      }),
    ),
  )
}

/**
 * Persist a Hermes send-stream turn frame into the canonical store.
 * Call from send-stream on user start / run bind / text update / settle.
 */
export function persistHermesCanonicalTurnFrame(input: {
  agentSessionId: string
  profileName?: string
  workspaceId?: string
  clientSubmitId: string
  userText?: string
  hermesRunId?: string | null
  assistantText?: string | null
  thinkingText?: string | null
  status?: 'streaming' | 'completed' | 'failed' | 'canceled'
  settled?: boolean
  occurredAtUnixMs?: number
  dbPath?: string
}): void {
  const agentSessionId = input.agentSessionId.trim()
  const clientSubmitId = input.clientSubmitId.trim()
  if (!agentSessionId || !clientSubmitId) return
  const turnId = `turn-${clientSubmitId}`
  const now = input.occurredAtUnixMs ?? Date.now()
  const workspaceId = input.workspaceId ?? 'default'
  const profileName = input.profileName ?? 'default'

  ensureHermesCanonicalSession({
    agentSessionId,
    workspaceId,
    profileName,
    gatewaySessionId: agentSessionId,
    dbPath: input.dbPath,
  })

  if (typeof input.userText === 'string' && input.userText.length > 0) {
    upsertHermesCanonicalMessage({
      workspaceId,
      agentSessionId,
      messageId: `user:${clientSubmitId}`,
      turnId,
      role: 'user',
      kind: 'text',
      status: 'completed',
      payload: { text: input.userText, clientSubmitId },
      occurredAtUnixMs: now,
      profileName,
      gatewaySessionId: agentSessionId,
      dbPath: input.dbPath,
    })
  }

  const runId = input.hermesRunId?.trim() || null
  if (runId) {
    const assistantMessageId = `assistant:${runId}`
    upsertHermesTurnRunIndex({
      agentSessionId,
      clientSubmitId,
      turnId,
      hermesRunId: runId,
      assistantMessageId,
      settledAtUnixMs: input.settled ? now : null,
      dbPath: input.dbPath,
    })
    if (typeof input.assistantText === 'string') {
      upsertHermesCanonicalMessage({
        workspaceId,
        agentSessionId,
        messageId: assistantMessageId,
        turnId,
        role: 'assistant',
        kind: 'text',
        status: input.status ?? (input.settled ? 'completed' : 'streaming'),
        payload: { text: input.assistantText, runId, clientSubmitId },
        occurredAtUnixMs: now,
        profileName,
        gatewaySessionId: agentSessionId,
        dbPath: input.dbPath,
      })
    }
    if (typeof input.thinkingText === 'string' && input.thinkingText.length > 0) {
      upsertHermesCanonicalMessage({
        workspaceId,
        agentSessionId,
        messageId: `${assistantMessageId}:thinking`,
        turnId,
        role: 'assistant',
        kind: 'reasoning',
        status: input.status ?? (input.settled ? 'completed' : 'streaming'),
        payload: { text: input.thinkingText, runId, clientSubmitId },
        occurredAtUnixMs: now,
        profileName,
        gatewaySessionId: agentSessionId,
        dbPath: input.dbPath,
      })
    }
  } else if (input.settled) {
    upsertHermesTurnRunIndex({
      agentSessionId,
      clientSubmitId,
      turnId,
      settledAtUnixMs: now,
      dbPath: input.dbPath,
    })
  }
}
