import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openSqliteDatabase } from './sqlite-helper'

export type ExecutionLease = {
  namespace: string
  key: string
  groupId: string
  owner: string
  token: string
  expiresAt: number
}

export class ControlPlaneStateStore {
  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.withDb((db) => db.exec(`
      CREATE TABLE IF NOT EXISTS control_plane_state (
        namespace TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE IF NOT EXISTS control_plane_leases (
        namespace TEXT NOT NULL, key TEXT NOT NULL, group_id TEXT NOT NULL,
        owner TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_control_plane_leases_group
        ON control_plane_leases(namespace, group_id);
    `))
  }

  private withDb<TResult>(run: (db: ReturnType<typeof openSqliteDatabase>) => TResult): TResult {
    const db = openSqliteDatabase(this.dbPath, false)
    try { return run(db) } finally { db.close() }
  }

  read<TValue>(namespace: string, key: string): TValue | null {
    return this.withDb((db) => {
      const row = db.prepare('SELECT payload FROM control_plane_state WHERE namespace=? AND key=?').get(namespace, key)
      return row ? JSON.parse(String(row.payload)) as TValue : null
    })
  }

  list<TValue>(namespace: string): Array<{ key: string; value: TValue }> {
    return this.withDb((db) => db.prepare('SELECT key, payload FROM control_plane_state WHERE namespace=?').all(namespace)
      .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.payload)) as TValue })))
  }

  write(namespace: string, key: string, value: unknown): void {
    this.withDb((db) => db.prepare(`INSERT INTO control_plane_state(namespace,key,payload) VALUES(?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET payload=excluded.payload`).run(namespace, key, JSON.stringify(value)))
  }

  remove(namespace: string, key: string): void {
    this.withDb((db) => db.prepare('DELETE FROM control_plane_state WHERE namespace=? AND key=?').run(namespace, key))
  }

  claim(input: { namespace: string; key: string; groupId: string; owner: string; globalLimit: number; groupLimit: number; ttlMs: number; now?: number }): ExecutionLease | null {
    const lease: ExecutionLease = { namespace: input.namespace, key: input.key, groupId: input.groupId, owner: input.owner, token: randomUUID(), expiresAt: (input.now ?? Date.now()) + input.ttlMs }
    return this.withDb((db) => {
      const result = db.prepare(`INSERT OR IGNORE INTO control_plane_leases(namespace,key,group_id,owner,token,expires_at)
        SELECT ?,?,?,?,?,? WHERE
        (SELECT COUNT(*) FROM control_plane_leases WHERE namespace=?) < ? AND
        (SELECT COUNT(*) FROM control_plane_leases WHERE namespace=? AND group_id=?) < ?`)
        .run(lease.namespace, lease.key, lease.groupId, lease.owner, lease.token, lease.expiresAt, lease.namespace, input.globalLimit, lease.namespace, lease.groupId, input.groupLimit)
      return result.changes === 1 ? lease : null
    })
  }

  owns(lease: ExecutionLease, now = Date.now()): boolean {
    return this.withDb((db) => Boolean(db.prepare(`SELECT 1 FROM control_plane_leases
      WHERE namespace=? AND key=? AND owner=? AND token=? AND expires_at>?`)
      .get(lease.namespace, lease.key, lease.owner, lease.token, now)))
  }

  renew(lease: ExecutionLease, ttlMs: number): void {
    const expiresAt = Date.now() + ttlMs
    const changed = this.withDb((db) => db.prepare(`UPDATE control_plane_leases SET expires_at=?
      WHERE namespace=? AND key=? AND owner=? AND token=?`).run(expiresAt, lease.namespace, lease.key, lease.owner, lease.token).changes)
    if (changed) lease.expiresAt = expiresAt
  }

  release(lease: ExecutionLease): void {
    this.withDb((db) => db.prepare('DELETE FROM control_plane_leases WHERE namespace=? AND key=? AND owner=? AND token=?')
      .run(lease.namespace, lease.key, lease.owner, lease.token))
  }

  reconcileTerminal(namespace: string, key: string): void {
    this.withDb((db) => db.prepare('DELETE FROM control_plane_leases WHERE namespace=? AND key=?').run(namespace, key))
  }

  leases(namespace: string): Array<ExecutionLease> {
    return this.withDb((db) => db.prepare('SELECT * FROM control_plane_leases WHERE namespace=?').all(namespace).map((row) => ({
      namespace: String(row.namespace), key: String(row.key), groupId: String(row.group_id), owner: String(row.owner), token: String(row.token), expiresAt: Number(row.expires_at),
    })))
  }
}