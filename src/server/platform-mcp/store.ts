/**
 * Platform MCP catalog + agent bindings (collab.db).
 * One server row, many agent_mcp_servers bindings — reuse without copying secrets.
 */
import { ensureCollabDb, getCollabDbPath, createCollabId } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'
import type {
  AgentMcpBinding,
  CreatePlatformMcpInput,
  PlatformMcpServer,
  PlatformMcpServerSummary,
  PlatformMcpTransport,
  UpdatePlatformMcpInput,
} from './types'

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

function normalizeMcpName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function readTransport(value: unknown): PlatformMcpTransport {
  return String(value || '').toLowerCase() === 'http' ? 'http' : 'stdio'
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* ignore */
  }
  return {}
}

function inferTransport(
  transport: unknown,
  config: Record<string, unknown>,
): PlatformMcpTransport {
  if (transport === 'http' || transport === 'stdio') return transport
  const t = String(config.transport || config.transportType || '').toLowerCase()
  if (t === 'http' || t === 'sse' || t === 'streamable-http') return 'http'
  if (config.url) return 'http'
  return 'stdio'
}

function mapServerRow(row: Record<string, unknown>): PlatformMcpServer {
  const config = parseConfig(row.config_json)
  return {
    id: String(row.id),
    name: String(row.name),
    transport: inferTransport(row.transport, config),
    config,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

export function listPlatformMcpServers(input?: {
  dbPath?: string
}): Array<PlatformMcpServerSummary> {
  return withDb(dbPath(input), true, (db) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.transport, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM agent_mcp_servers a WHERE a.server_id = s.id) AS bound_agent_count
         FROM platform_mcp_servers s
         ORDER BY s.name COLLATE NOCASE`,
      )
      .all()
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      transport: readTransport(row.transport),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      boundAgentCount: Number(row.bound_agent_count ?? 0),
    }))
  })
}

export function getPlatformMcpServer(
  idOrName: string,
  input?: { dbPath?: string },
): PlatformMcpServer | null {
  const key = idOrName.trim()
  if (!key) return null
  return withDb(dbPath(input), true, (db) => {
    const row = db
      .prepare(
        'SELECT * FROM platform_mcp_servers WHERE id = ? OR name = ?',
      )
      .get(key, key)
    if (!row) return null
    return mapServerRow(row as Record<string, unknown>)
  })
}

export function createPlatformMcpServer(
  input: CreatePlatformMcpInput,
  opts?: { dbPath?: string },
): PlatformMcpServer {
  const name = normalizeMcpName(input.name)
  if (!name) throw new Error('name is required')
  const config =
    input.config && typeof input.config === 'object' && !Array.isArray(input.config)
      ? { ...input.config }
      : {}
  const transport = inferTransport(input.transport, config)
  const id = (input.id || createCollabId('mcp')).trim()
  const now = Date.now()
  withDb(dbPath(opts), false, (db) => {
    const existing = db
      .prepare('SELECT id FROM platform_mcp_servers WHERE name = ?')
      .get(name)
    if (existing) throw new Error(`MCP server already exists: ${name}`)
    db.prepare(
      `INSERT INTO platform_mcp_servers
       (id, name, transport, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, transport, JSON.stringify(config), now, now)
  })
  const created = getPlatformMcpServer(id, opts)
  if (!created) throw new Error('Failed to create MCP server')
  return created
}

export function updatePlatformMcpServer(
  idOrName: string,
  input: UpdatePlatformMcpInput,
  opts?: { dbPath?: string },
): PlatformMcpServer {
  const key = idOrName.trim()
  if (!key) throw new Error('id is required')
  withDb(dbPath(opts), false, (db) => {
    const row = db
      .prepare(
        'SELECT * FROM platform_mcp_servers WHERE id = ? OR name = ?',
      )
      .get(key, key)
    if (!row) throw new Error(`MCP server not found: ${key}`)
    const id = String(row.id)
    let name = String(row.name)
    let transport = readTransport(row.transport)
    let config = parseConfig(row.config_json)
    if (typeof input.name === 'string' && input.name.trim()) {
      const nextName = normalizeMcpName(input.name)
      if (nextName !== name) {
        const clash = db
          .prepare(
            'SELECT id FROM platform_mcp_servers WHERE name = ? AND id != ?',
          )
          .get(nextName, id)
        if (clash) throw new Error(`MCP server already exists: ${nextName}`)
        name = nextName
      }
    }
    if (input.config && typeof input.config === 'object' && !Array.isArray(input.config)) {
      config = { ...input.config }
    }
    if (input.transport === 'http' || input.transport === 'stdio') {
      transport = input.transport
    } else {
      transport = inferTransport(transport, config)
    }
    db.prepare(
      `UPDATE platform_mcp_servers
       SET name = ?, transport = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, transport, JSON.stringify(config), Date.now(), id)
  })
  const updated = getPlatformMcpServer(key, opts)
  if (!updated) throw new Error(`MCP server not found: ${key}`)
  return updated
}

export function deletePlatformMcpServer(
  idOrName: string,
  opts?: { dbPath?: string },
): boolean {
  const key = idOrName.trim()
  if (!key) return false
  return withDb(dbPath(opts), false, (db) => {
    const row = db
      .prepare('SELECT id FROM platform_mcp_servers WHERE id = ? OR name = ?')
      .get(key, key)
    if (!row) return false
    // CASCADE removes agent_mcp_servers bindings
    db.prepare('DELETE FROM platform_mcp_servers WHERE id = ?').run(
      String(row.id),
    )
    return true
  })
}

export function listAgentMcpBindings(
  agentId: string,
  input?: { dbPath?: string; enabledOnly?: boolean },
): Array<AgentMcpBinding> {
  const id = agentId.trim()
  if (!id) return []
  return withDb(dbPath(input), true, (db) => {
    const sql = input?.enabledOnly
      ? `SELECT a.agent_id, a.server_id, a.enabled, a.created_at, s.name, s.transport
         FROM agent_mcp_servers a
         JOIN platform_mcp_servers s ON s.id = a.server_id
         WHERE a.agent_id = ? AND a.enabled = 1
         ORDER BY s.name COLLATE NOCASE`
      : `SELECT a.agent_id, a.server_id, a.enabled, a.created_at, s.name, s.transport
         FROM agent_mcp_servers a
         JOIN platform_mcp_servers s ON s.id = a.server_id
         WHERE a.agent_id = ?
         ORDER BY s.name COLLATE NOCASE`
    return db.prepare(sql).all(id).map((row) => ({
      agentId: String(row.agent_id),
      serverId: String(row.server_id),
      enabled: Number(row.enabled ?? 0) === 1,
      createdAt: Number(row.created_at ?? 0),
      name: String(row.name),
      transport: readTransport(row.transport),
    }))
  })
}

export function listMcpServerAgentBindings(
  serverId: string,
  input?: { dbPath?: string },
): Array<{ agentId: string; enabled: boolean; createdAt: number }> {
  const id = serverId.trim()
  if (!id) return []
  return withDb(dbPath(input), true, (db) => {
    const server = db
      .prepare('SELECT id FROM platform_mcp_servers WHERE id = ? OR name = ?')
      .get(id, id)
    if (!server) return []
    return db
      .prepare(
        `SELECT agent_id, enabled, created_at
         FROM agent_mcp_servers WHERE server_id = ? ORDER BY agent_id`,
      )
      .all(String(server.id))
      .map((row) => ({
        agentId: String(row.agent_id),
        enabled: Number(row.enabled ?? 0) === 1,
        createdAt: Number(row.created_at ?? 0),
      }))
  })
}

export function addAgentMcpServers(
  agentId: string,
  serverIds: Array<string>,
  input?: { dbPath?: string },
): Array<AgentMcpBinding> {
  const id = agentId.trim()
  if (!id) throw new Error('agentId is required')
  const unique = [...new Set(serverIds.map((s) => s.trim()).filter(Boolean))]
  if (unique.length === 0) return listAgentMcpBindings(id, input)
  withDb(dbPath(input), false, (db) => {
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO agent_mcp_servers (agent_id, server_id, enabled, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(agent_id, server_id) DO NOTHING`,
    )
    for (const serverId of unique) {
      const row = db
        .prepare(
          'SELECT id FROM platform_mcp_servers WHERE id = ? OR name = ?',
        )
        .get(serverId, serverId)
      if (!row) throw new Error(`MCP server not found: ${serverId}`)
      insert.run(id, String(row.id), now)
    }
  })
  return listAgentMcpBindings(id, input)
}

export function setAgentMcpEnabled(
  agentId: string,
  serverId: string,
  enabled: boolean,
  input?: { dbPath?: string },
): AgentMcpBinding | null {
  const aid = agentId.trim()
  const sid = serverId.trim()
  if (!aid || !sid) return null
  return withDb(dbPath(input), false, (db) => {
    const server = db
      .prepare('SELECT id FROM platform_mcp_servers WHERE id = ? OR name = ?')
      .get(sid, sid)
    if (!server) return null
    const result = db
      .prepare(
        `UPDATE agent_mcp_servers SET enabled = ? WHERE agent_id = ? AND server_id = ?`,
      )
      .run(enabled ? 1 : 0, aid, String(server.id))
    if (result.changes === 0) return null
    const row = db
      .prepare(
        `SELECT a.agent_id, a.server_id, a.enabled, a.created_at, s.name, s.transport
         FROM agent_mcp_servers a
         JOIN platform_mcp_servers s ON s.id = a.server_id
         WHERE a.agent_id = ? AND a.server_id = ?`,
      )
      .get(aid, String(server.id))
    if (!row) return null
    return {
      agentId: String(row.agent_id),
      serverId: String(row.server_id),
      enabled: Number(row.enabled ?? 0) === 1,
      createdAt: Number(row.created_at ?? 0),
      name: String(row.name),
      transport: readTransport(row.transport),
    }
  })
}

export function removeAgentMcpServer(
  agentId: string,
  serverId: string,
  input?: { dbPath?: string },
): boolean {
  const aid = agentId.trim()
  const sid = serverId.trim()
  if (!aid || !sid) return false
  return withDb(dbPath(input), false, (db) => {
    const server = db
      .prepare('SELECT id FROM platform_mcp_servers WHERE id = ? OR name = ?')
      .get(sid, sid)
    if (!server) return false
    const result = db
      .prepare(
        'DELETE FROM agent_mcp_servers WHERE agent_id = ? AND server_id = ?',
      )
      .run(aid, String(server.id))
    return result.changes > 0
  })
}

/** Agents that currently bind this server (for rematerialize after library edit). */
export function listAgentIdsBoundToMcp(
  serverId: string,
  input?: { dbPath?: string },
): Array<string> {
  return listMcpServerAgentBindings(serverId, input).map((b) => b.agentId)
}
