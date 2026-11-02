import { ensureCollabDb, getCollabDbPath } from './collab-db'
import { openSqliteDatabase } from './sqlite-helper'

export type ExecutionNodeStatus = 'online' | 'offline'

export type ExecutionNode = {
  id: string
  name: string
  baseUrl: string
  workspaceId: string
  status: ExecutionNodeStatus
  capabilities: Array<string>
  lastSeenAt: number | null
  createdAt: number
  updatedAt: number
}

type ExecutionNodeRow = {
  id: string
  name: string
  base_url: string
  workspace_id: string
  status: ExecutionNodeStatus
  capabilities_json: string
  last_seen_at: number | null
  created_at: number
  updated_at: number
}

export type UpsertExecutionNodeInput = {
  id: string
  name: string
  baseUrl: string
  workspaceId?: string
  capabilities?: Array<string>
}

function normalizeNodeId(value: string): string {
  const id = value.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error('node id must be 1-64 URL-safe characters')
  }
  return id
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('node baseUrl must be a valid URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('node baseUrl must use http or https')
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname,
  )
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('remote node baseUrl must use https')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'node baseUrl must not contain credentials, query, or fragment',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function parseCapabilities(raw: string): Array<string> {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function fromRow(row: ExecutionNodeRow): ExecutionNode {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    workspaceId: row.workspace_id,
    status: row.status,
    capabilities: parseCapabilities(row.capabilities_json),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function upsertExecutionNode(
  input: UpsertExecutionNodeInput,
  dbPath = getCollabDbPath(),
): ExecutionNode {
  ensureCollabDb(dbPath)
  const id = normalizeNodeId(input.id)
  const name = input.name.trim()
  if (!name) throw new Error('node name is required')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const workspaceId = input.workspaceId?.trim() || 'default'
  const capabilities = [...new Set(input.capabilities ?? [])].sort()
  const now = Date.now()
  const db = openSqliteDatabase(dbPath, false)
  try {
    db.prepare(
      `INSERT INTO execution_nodes (
        id, name, base_url, workspace_id, status, capabilities_json,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        workspace_id = excluded.workspace_id,
        status = 'online',
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`,
    ).run(
      id,
      name,
      baseUrl,
      workspaceId,
      JSON.stringify(capabilities),
      now,
      now,
      now,
    )
    return getExecutionNode(id, dbPath)!
  } finally {
    db.close()
  }
}

export function getExecutionNode(
  id: string,
  dbPath = getCollabDbPath(),
): ExecutionNode | null {
  ensureCollabDb(dbPath)
  const db = openSqliteDatabase(dbPath, true)
  try {
    const row = db
      .prepare('SELECT * FROM execution_nodes WHERE id = ?')
      .get(id) as ExecutionNodeRow | undefined
    return row ? fromRow(row) : null
  } finally {
    db.close()
  }
}

export function listExecutionNodes(
  dbPath = getCollabDbPath(),
): Array<ExecutionNode> {
  ensureCollabDb(dbPath)
  const db = openSqliteDatabase(dbPath, true)
  try {
    return (
      db
        .prepare('SELECT * FROM execution_nodes ORDER BY name, id')
        .all() as Array<ExecutionNodeRow>
    ).map(fromRow)
  } finally {
    db.close()
  }
}

export function heartbeatExecutionNode(
  id: string,
  capabilities?: Array<string>,
  dbPath = getCollabDbPath(),
): ExecutionNode | null {
  ensureCollabDb(dbPath)
  const now = Date.now()
  const db = openSqliteDatabase(dbPath, false)
  try {
    const result = capabilities
      ? db
          .prepare(
            `UPDATE execution_nodes SET status = 'online', last_seen_at = ?,
             updated_at = ?, capabilities_json = ? WHERE id = ?`,
          )
          .run(now, now, JSON.stringify([...new Set(capabilities)].sort()), id)
      : db
          .prepare(
            `UPDATE execution_nodes SET status = 'online', last_seen_at = ?,
             updated_at = ? WHERE id = ?`,
          )
          .run(now, now, id)
    if (result.changes === 0) return null
  } finally {
    db.close()
  }
  return getExecutionNode(id, dbPath)
}

export function markStaleExecutionNodesOffline(
  staleBefore: number,
  dbPath = getCollabDbPath(),
): number {
  ensureCollabDb(dbPath)
  const db = openSqliteDatabase(dbPath, false)
  try {
    return db
      .prepare(
        `UPDATE execution_nodes SET status = 'offline', updated_at = ?
         WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      )
      .run(Date.now(), staleBefore).changes
  } finally {
    db.close()
  }
}

export function deleteExecutionNode(
  id: string,
  dbPath = getCollabDbPath(),
): boolean {
  ensureCollabDb(dbPath)
  const db = openSqliteDatabase(dbPath, false)
  try {
    return (
      db.prepare('DELETE FROM execution_nodes WHERE id = ?').run(id).changes > 0
    )
  } finally {
    db.close()
  }
}
