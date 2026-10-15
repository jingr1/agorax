/**
 * Durable Agorax ↔ Hermes gateway run mapping (collab.db).
 * Used by Hermes 1:1 Engine commandPort for cancel/resume after refresh.
 */

import type { AgoraxRunMapping } from './agent-runtime/hermes-native-bridge'
import { ensureCollabDb, getCollabDbPath } from './collab-db'
import { openSqliteDatabase } from './sqlite-helper'

type MappingRow = {
  agent_session_id: string
  turn_id: string | null
  gateway_session_id: string | null
  hermes_run_id: string | null
  bridge_kind: string
  updated_at: number
}

function dbPath(input?: { dbPath?: string }): string {
  return input?.dbPath ?? getCollabDbPath()
}

function ensureDb(input?: { dbPath?: string }): void {
  ensureCollabDb(dbPath(input))
}

function rowToMapping(row: MappingRow): AgoraxRunMapping {
  return {
    agentSessionId: row.agent_session_id,
    turnId: row.turn_id,
    gatewaySessionId: row.gateway_session_id,
    assignmentId: null,
    hermesRunId: row.hermes_run_id,
    bridgeKind: 'hermes-native',
    updatedAtUnixMs: row.updated_at,
  }
}

export function upsertAgoraxRunMapping(
  mapping: AgoraxRunMapping,
  input?: { dbPath?: string },
): AgoraxRunMapping {
  ensureDb(input)
  const next: AgoraxRunMapping = {
    ...mapping,
    agentSessionId: mapping.agentSessionId.trim(),
    turnId: mapping.turnId?.trim() || null,
    gatewaySessionId: mapping.gatewaySessionId?.trim() || null,
    hermesRunId: mapping.hermesRunId?.trim() || null,
    bridgeKind: 'hermes-native',
    updatedAtUnixMs: mapping.updatedAtUnixMs || Date.now(),
  }
  if (!next.agentSessionId) {
    throw new Error('agorax_run_mapping requires agentSessionId')
  }
  const d = openSqliteDatabase(dbPath(input), false)
  try {
    d.prepare(
      `INSERT INTO agorax_run_mapping
         (agent_session_id, turn_id, gateway_session_id, hermes_run_id, bridge_kind, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_session_id) DO UPDATE SET
         turn_id = excluded.turn_id,
         gateway_session_id = excluded.gateway_session_id,
         hermes_run_id = excluded.hermes_run_id,
         bridge_kind = excluded.bridge_kind,
         updated_at = excluded.updated_at`,
    ).run(
      next.agentSessionId,
      next.turnId,
      next.gatewaySessionId,
      next.hermesRunId,
      next.bridgeKind,
      next.updatedAtUnixMs,
    )
  } finally {
    d.close()
  }
  return next
}

export function getAgoraxRunMappingByAgentSessionId(
  agentSessionId: string,
  input?: { dbPath?: string },
): AgoraxRunMapping | null {
  const id = agentSessionId.trim()
  if (!id) return null
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT agent_session_id, turn_id, gateway_session_id, hermes_run_id, bridge_kind, updated_at
         FROM agorax_run_mapping WHERE agent_session_id = ?`,
      )
      .all(id) as MappingRow[]
    if (rows.length === 0) return null
    return rowToMapping(rows[0]!)
  } finally {
    d.close()
  }
}

export function getAgoraxRunMappingByGatewaySessionId(
  gatewaySessionId: string,
  input?: { dbPath?: string },
): AgoraxRunMapping | null {
  const id = gatewaySessionId.trim()
  if (!id) return null
  ensureDb(input)
  const d = openSqliteDatabase(dbPath(input), true)
  try {
    const rows = d
      .prepare(
        `SELECT agent_session_id, turn_id, gateway_session_id, hermes_run_id, bridge_kind, updated_at
         FROM agorax_run_mapping
         WHERE gateway_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .all(id) as MappingRow[]
    if (rows.length === 0) return null
    return rowToMapping(rows[0]!)
  } finally {
    d.close()
  }
}

export function patchAgoraxRunMapping(
  agentSessionId: string,
  patch: Partial<
    Pick<
      AgoraxRunMapping,
      'turnId' | 'gatewaySessionId' | 'hermesRunId'
    >
  >,
  input?: { dbPath?: string },
): AgoraxRunMapping | null {
  const existing = getAgoraxRunMappingByAgentSessionId(agentSessionId, input)
  if (!existing) return null
  return upsertAgoraxRunMapping(
    {
      ...existing,
      ...patch,
      updatedAtUnixMs: Date.now(),
    },
    input,
  )
}
