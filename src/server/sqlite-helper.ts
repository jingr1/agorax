import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'

// createRequire is the canonical ESM→CJS bridge. We need it because
// better-sqlite3 / node:sqlite are native modules and Vite runs in ESM mode.
// @ts-ignore -- LSP/tsconfig doesn't include node types but runtime has it
import { createRequire as _createRequire } from 'node:module'
// @ts-ignore -- LSP/tsconfig doesn't include node types but runtime has it
const nodeRequire = _createRequire(import.meta.url)

export type SqliteDatabase = {
  prepare: (sql: string) => {
    all: (...params: Array<unknown>) => Array<Record<string, unknown>>
    get: (...params: Array<unknown>) => Record<string, unknown> | undefined
    run: (...params: Array<unknown>) => { changes: number }
  }
  exec: (sql: string) => void
  close: () => void
}

export type SqliteDriver = 'better-sqlite3' | 'node:sqlite'

let sqliteDriverWarningShown = false
let sqliteCliWarningShown = false

function warnSqliteFallback(
  driver: SqliteDriver | 'sqlite3-cli',
  detail?: string,
): void {
  if (driver === 'node:sqlite') {
    if (sqliteDriverWarningShown) return
    sqliteDriverWarningShown = true
    console.warn(
      '[sqlite-helper] better-sqlite3 unavailable; falling back to experimental node:sqlite' +
        (detail ? ` (${detail})` : '') +
        '. Install better-sqlite3 for the supported local path.',
    )
    return
  }
  if (driver === 'sqlite3-cli') {
    if (sqliteCliWarningShown) return
    sqliteCliWarningShown = true
    console.warn(
      '[sqlite-helper] in-process SQLite unavailable; falling back to system sqlite3 CLI' +
        (detail ? ` (${detail})` : '') +
        '. Install better-sqlite3 for the supported local path.',
    )
  }
}

export function openSqliteDatabase(
  dbPath: string,
  readOnly: boolean,
): SqliteDatabase {
  let Database: new (
    path: string,
    opts?: Record<string, unknown>,
  ) => SqliteDatabase
  let driver: SqliteDriver
  try {
    Database = nodeRequire('better-sqlite3')
    driver = 'better-sqlite3'
  } catch (error) {
    Database = nodeRequire('node:sqlite').DatabaseSync
    driver = 'node:sqlite'
    warnSqliteFallback(
      'node:sqlite',
      error instanceof Error ? error.message : String(error),
    )
  }
  // better-sqlite3 uses `readonly`; node:sqlite DatabaseSync uses `readOnly`.
  const opts = readOnly
    ? driver === 'better-sqlite3'
      ? { readonly: true }
      : { readOnly: true }
    : undefined
  const db = new Database(dbPath, opts)
  // WAL + busy_timeout: the workspace server hosts N concurrent agents (plan
  // targets 8) all writing run state; without these, concurrent writes hit
  // SQLITE_BUSY immediately.
  if (!readOnly) {
    try {
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec('PRAGMA busy_timeout = 5000;')
    } catch {
      // PRAGMAs are best-effort (e.g. node:sqlite may not support both).
    }
  }
  return db
}

/**
 * Run SQL against a SQLite database.
 * Prefer better-sqlite3 (product path); fall back to experimental node:sqlite,
 * then to the system sqlite3 CLI (tests / last resort).
 */
export function runSqlite(dbPath: string, sql: string): string {
  const trimmed = sql.trim()
  const isSelect = /^select\b/i.test(trimmed)

  if (fs.existsSync(dbPath)) {
    try {
      const db = openSqliteDatabase(dbPath, isSelect)
      try {
        if (isSelect) {
          const rows = db.prepare(trimmed).all()
          return rows.length > 0 ? JSON.stringify(rows) : ''
        }
        db.exec(trimmed)
        return ''
      } finally {
        db.close()
      }
    } catch (error) {
      warnSqliteFallback(
        'sqlite3-cli',
        error instanceof Error ? error.message : String(error),
      )
      // Fall through to CLI — tests mock execFileSync('sqlite3', ...).
    }
  }

  return execFileSync('sqlite3', [dbPath, '-json', sql], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim()
}

export function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
