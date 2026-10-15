import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureCollabDb, getCollabDbVersion, createCollabId } from './collab-db'
import { openSqliteDatabase } from './sqlite-helper'

let tempRoot: string

describe('collab-db', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'collab-db-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('creates collab.db with schema_migrations and all tables', () => {
    const dbPath = join(tempRoot, 'collab.db')
    ensureCollabDb(dbPath)
    expect(getCollabDbVersion(dbPath)).toBeGreaterThanOrEqual(10)
    const db = openSqliteDatabase(dbPath, true)
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?)",
        )
        .all('missions', 'assignments', 'mission_events') as Array<{
        name: string
      }>
      expect(tables.map((t) => t.name).sort()).toEqual([
        'assignments',
        'mission_events',
        'missions',
      ])
    } finally {
      db.close()
    }
  })

  it('is idempotent — running twice does not error or duplicate version', () => {
    const dbPath = join(tempRoot, 'collab.db')
    ensureCollabDb(dbPath)
    ensureCollabDb(dbPath)
    expect(getCollabDbVersion(dbPath)).toBeGreaterThanOrEqual(10)
  })

  it('creates unique ids with prefix', () => {
    const id1 = createCollabId('run')
    const id2 = createCollabId('run')
    expect(id1).toMatch(/^run_[a-f0-9]{12}$/)
    expect(id2).toMatch(/^run_[a-f0-9]{12}$/)
    expect(id1).not.toBe(id2)
  })
})
