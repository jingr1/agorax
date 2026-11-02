import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { ensureCollabDb, getCollabDbPath } from '../collab-db'
import { openSqliteDatabase } from '../sqlite-helper'

export type PersistentDispatchClaim = Readonly<{
  missionId: string
  assignmentId: string
  nodeId: string | null
  ownerId: string
  attempt: number
  leaseExpiresAt: number
}>

const DEFAULT_LEASE_MS = 10 * 60_000
const defaultOwnerId =
  process.env.AGORAX_SCHEDULER_OWNER_ID?.trim() ||
  `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

type ClaimRow = {
  mission_id: string
  assignment_id: string
  node_id: string | null
  owner_id: string
  attempt: number
  status: 'claimed' | 'running' | 'released' | 'terminal'
  lease_expires_at: number
}

export function acquireDispatchClaim(
  input: {
    missionId: string
    assignmentId: string
    nodeId?: string | null
    ownerId?: string
    nowMs?: number
    leaseMs?: number
  },
  dbPath = getCollabDbPath(),
): PersistentDispatchClaim | null {
  ensureCollabDb(dbPath)
  const ownerId = input.ownerId ?? defaultOwnerId
  const nowMs = input.nowMs ?? Date.now()
  const leaseExpiresAt = nowMs + (input.leaseMs ?? DEFAULT_LEASE_MS)
  const db = openSqliteDatabase(dbPath, false)
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = db
      .prepare('SELECT * FROM task_dispatch_claims WHERE assignment_id = ?')
      .get(input.assignmentId) as ClaimRow | undefined
    if (current?.status === 'terminal') {
      db.exec('COMMIT')
      return null
    }
    if (
      current &&
      current.status !== 'released' &&
      current.lease_expires_at > nowMs
    ) {
      db.exec('COMMIT')
      return null
    }
    const attempt = (current?.attempt ?? 0) + 1
    db.prepare(
      `INSERT INTO task_dispatch_claims (
        assignment_id, mission_id, node_id, owner_id, attempt, status,
        claimed_at, lease_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        mission_id = excluded.mission_id,
        node_id = excluded.node_id,
        owner_id = excluded.owner_id,
        attempt = excluded.attempt,
        status = 'claimed',
        claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at`,
    ).run(
      input.assignmentId,
      input.missionId,
      input.nodeId ?? null,
      ownerId,
      attempt,
      nowMs,
      leaseExpiresAt,
      nowMs,
    )
    db.exec('COMMIT')
    return {
      missionId: input.missionId,
      assignmentId: input.assignmentId,
      nodeId: input.nodeId ?? null,
      ownerId,
      attempt,
      leaseExpiresAt,
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

export function ownsDispatchClaim(
  claim: PersistentDispatchClaim,
  dbPath = getCollabDbPath(),
  nowMs = Date.now(),
): boolean {
  ensureCollabDb(dbPath)
  const db = openSqliteDatabase(dbPath, true)
  try {
    const row = db
      .prepare(
        `SELECT * FROM task_dispatch_claims
         WHERE assignment_id = ? AND owner_id = ? AND attempt = ?`,
      )
      .get(claim.assignmentId, claim.ownerId, claim.attempt) as
      | ClaimRow
      | undefined
    return Boolean(
      row &&
      (row.status === 'claimed' || row.status === 'running') &&
      row.lease_expires_at > nowMs,
    )
  } finally {
    db.close()
  }
}

export function renewDispatchClaim(
  claim: PersistentDispatchClaim,
  status: 'claimed' | 'running',
  dbPath = getCollabDbPath(),
  nowMs = Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
): PersistentDispatchClaim | null {
  ensureCollabDb(dbPath)
  const leaseExpiresAt = nowMs + leaseMs
  const db = openSqliteDatabase(dbPath, false)
  try {
    const result = db
      .prepare(
        `UPDATE task_dispatch_claims SET status = ?, lease_expires_at = ?, updated_at = ?
         WHERE assignment_id = ? AND owner_id = ? AND attempt = ?
           AND status IN ('claimed','running')`,
      )
      .run(
        status,
        leaseExpiresAt,
        nowMs,
        claim.assignmentId,
        claim.ownerId,
        claim.attempt,
      )
    return result.changes > 0 ? { ...claim, leaseExpiresAt } : null
  } finally {
    db.close()
  }
}

export function releaseDispatchClaim(
  claim: PersistentDispatchClaim,
  terminal = false,
  dbPath = getCollabDbPath(),
): boolean {
  ensureCollabDb(dbPath)
  const db = openSqliteDatabase(dbPath, false)
  try {
    return (
      db
        .prepare(
          `UPDATE task_dispatch_claims SET status = ?, updated_at = ?
           WHERE assignment_id = ? AND owner_id = ? AND attempt = ?
             AND status IN ('claimed','running')`,
        )
        .run(
          terminal ? 'terminal' : 'released',
          Date.now(),
          claim.assignmentId,
          claim.ownerId,
          claim.attempt,
        ).changes > 0
    )
  } finally {
    db.close()
  }
}
