import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

export type MemoryFileMeta = {
  path: string
  name: string
  size: number
  modified: string
}

export type ManagedMemoryBackend = 'claude-code' | 'codex' | 'filesystem'

export type ManagedMemoryHome = {
  backend: ManagedMemoryBackend
  root: string
  /** Human hint shown in empty states. */
  hint: string
  writable: boolean
}

function firstExistingDir(candidates: Array<string>): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
    } catch {
      // continue
    }
  }
  return null
}

/** Map agents.yaml runtime → on-disk memory home. */
export function resolveManagedMemoryHome(
  runtime: string,
): ManagedMemoryHome | null {
  const home = os.homedir()
  switch (runtime) {
    case 'claude-code': {
      const root = path.join(home, '.claude')
      if (!fs.existsSync(root)) return null
      return {
        backend: 'claude-code',
        root: path.resolve(root),
        hint: '~/.claude (CLAUDE.md + projects/*/memory)',
        writable: true,
      }
    }
    case 'codex': {
      const root = path.join(home, '.codex')
      if (!fs.existsSync(root)) return null
      return {
        backend: 'codex',
        root: path.resolve(root),
        hint: '~/.codex (memories_*.sqlite + AGENTS.md)',
        writable: false,
      }
    }
    case 'kimi': {
      const root = firstExistingDir([
        path.join(home, '.kimi-code'),
        path.join(home, '.kimi'),
      ])
      if (!root) return null
      return {
        backend: 'filesystem',
        root,
        hint: path.basename(root) === '.kimi-code' ? '~/.kimi-code' : '~/.kimi',
        writable: true,
      }
    }
    case 'cursor': {
      const root = path.join(home, '.cursor')
      if (!fs.existsSync(root)) return null
      return {
        backend: 'filesystem',
        root: path.resolve(root),
        hint: '~/.cursor',
        writable: true,
      }
    }
    case 'opencode': {
      const root = firstExistingDir([
        path.join(home, '.config', 'opencode'),
        path.join(home, '.opencode'),
        path.join(home, '.local', 'share', 'opencode'),
      ])
      if (!root) return null
      return {
        backend: 'filesystem',
        root,
        hint: root.replace(home, '~'),
        writable: true,
      }
    }
    case 'deepseek-harness': {
      const root = firstExistingDir([
        path.join(home, '.deepseek'),
        path.join(home, '.deepseek-harness'),
      ])
      if (!root) return null
      return {
        backend: 'filesystem',
        root,
        hint: root.replace(home, '~'),
        writable: true,
      }
    }
    default:
      return null
  }
}

function pushMd(
  entries: Array<MemoryFileMeta>,
  workspaceRoot: string,
  fullPath: string,
  allow: (relativePath: string) => boolean,
) {
  if (!fullPath.toLowerCase().endsWith('.md')) return
  let stats: fs.Stats
  try {
    stats = fs.statSync(fullPath)
  } catch {
    return
  }
  if (!stats.isFile()) return
  const relativePath = path
    .relative(workspaceRoot, fullPath)
    .replace(/\\/g, '/')
  if (!allow(relativePath)) return
  entries.push({
    path: relativePath,
    name: path.basename(fullPath),
    size: stats.size,
    modified: stats.mtime.toISOString(),
  })
}

function walkMd(
  entries: Array<MemoryFileMeta>,
  workspaceRoot: string,
  dirPath: string,
  allow: (relativePath: string) => boolean,
  skipDir: (name: string) => boolean,
) {
  let names: Array<string>
  try {
    names = fs.readdirSync(dirPath)
  } catch {
    return
  }
  for (const name of names) {
    if (skipDir(name)) continue
    const fullPath = path.join(dirPath, name)
    let stats: fs.Stats
    try {
      stats = fs.statSync(fullPath)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      walkMd(entries, workspaceRoot, fullPath, allow, skipDir)
      continue
    }
    pushMd(entries, workspaceRoot, fullPath, allow)
  }
}

function isClaudeMemoryPath(relativePath: string): boolean {
  if (relativePath === 'CLAUDE.md') return true
  // Auto-memory: projects/<slug>/memory/**/*.md
  return /^projects\/[^/]+\/memory\/.+\.md$/i.test(relativePath)
}

function listClaudeCodeMemoryFiles(root: string): Array<MemoryFileMeta> {
  const results: Array<MemoryFileMeta> = []
  pushMd(results, root, path.join(root, 'CLAUDE.md'), isClaudeMemoryPath)

  const projectsRoot = path.join(root, 'projects')
  let projectDirs: Array<string> = []
  try {
    projectDirs = fs.readdirSync(projectsRoot)
  } catch {
    projectDirs = []
  }

  for (const slug of projectDirs) {
    if (slug.startsWith('.')) continue
    const memoryDir = path.join(projectsRoot, slug, 'memory')
    walkMd(
      results,
      root,
      memoryDir,
      isClaudeMemoryPath,
      (name) => name === '.git' || name === 'node_modules',
    )
  }

  return results
}

function isGenericManagedMemoryPath(relativePath: string): boolean {
  const base = relativePath.toLowerCase()
  return (
    base === 'claude.md' ||
    base === 'agents.md' ||
    base === 'memory.md' ||
    base === 'user.md' ||
    base === 'soul.md' ||
    relativePath.startsWith('memory/') ||
    relativePath.startsWith('memories/') ||
    /^projects\/[^/]+\/memory\/.+\.md$/i.test(relativePath)
  )
}

function listFilesystemManagedMemoryFiles(root: string): Array<MemoryFileMeta> {
  const results: Array<MemoryFileMeta> = []
  for (const name of [
    'CLAUDE.md',
    'AGENTS.md',
    'MEMORY.md',
    'USER.md',
    'SOUL.md',
  ]) {
    pushMd(results, root, path.join(root, name), isGenericManagedMemoryPath)
  }
  for (const subdir of ['memory', 'memories']) {
    walkMd(
      results,
      root,
      path.join(root, subdir),
      isGenericManagedMemoryPath,
      (name) =>
        name === '.git' ||
        name === 'node_modules' ||
        name === 'skills' ||
        name === 'plugins' ||
        name === 'cache',
    )
  }
  const projectsRoot = path.join(root, 'projects')
  if (fs.existsSync(projectsRoot)) {
    walkMd(
      results,
      root,
      projectsRoot,
      (relativePath) =>
        /^projects\/[^/]+\/memory\/.+\.md$/i.test(relativePath) ||
        /^projects\/[^/]+\/(?:CLAUDE|AGENTS|MEMORY)\.md$/i.test(relativePath),
      (name) => name === '.git' || name === 'node_modules',
    )
  }
  return results
}

function findCodexMemoriesDb(root: string): string | null {
  let names: Array<string> = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }
  // Prefer highest memories_N.sqlite
  const matches = names
    .filter((name) => /^memories_\d+\.sqlite$/i.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return matches[0] ? path.join(root, matches[0]) : null
}

function listCodexMemoryFiles(root: string): Array<MemoryFileMeta> {
  const results: Array<MemoryFileMeta> = []
  pushMd(
    results,
    root,
    path.join(root, 'AGENTS.md'),
    (relativePath) => relativePath === 'AGENTS.md',
  )

  const dbPath = findCodexMemoriesDb(root)
  if (!dbPath) return results

  try {
    // Prefer python sqlite (better-sqlite3 may segfault on some host builds).
    const { execFileSync } = nodeRequire('node:child_process') as typeof import('node:child_process')
    const script = `
import json, sqlite3, os, time
path = ${JSON.stringify(dbPath)}
con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
cur = con.cursor()
tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if "stage1_outputs" not in tables:
  print("[]")
  raise SystemExit
rows = cur.execute(
  """
  SELECT thread_id, raw_memory, rollout_summary, rollout_slug, generated_at
  FROM stage1_outputs
  ORDER BY generated_at DESC
  LIMIT 200
  """
).fetchall()
out = []
for thread_id, raw, summary, slug, generated_at in rows:
  body = (raw or summary or "").strip()
  if not body:
    continue
  safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in (slug or thread_id or "memory"))[:80]
  mtime = int(generated_at or 0)
  if mtime > 10_000_000_000:
    mtime = mtime // 1000
  out.append({
    "path": f"memories/{safe or thread_id}.md",
    "name": f"{safe or thread_id}.md",
    "size": len(body.encode("utf-8")),
    "modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime or time.time())),
    "threadId": thread_id,
  })
print(json.dumps(out))
`
    const stdout = execFileSync('python3', ['-c', script], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout || '[]') as Array<MemoryFileMeta>
    for (const entry of parsed) {
      results.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        modified: entry.modified,
      })
    }
  } catch {
    // Codex DB unreadable — still return AGENTS.md if present.
  }

  return results
}

export function listManagedMemoryFiles(
  home: ManagedMemoryHome,
): Array<MemoryFileMeta> {
  switch (home.backend) {
    case 'claude-code':
      return listClaudeCodeMemoryFiles(home.root)
    case 'codex':
      return listCodexMemoryFiles(home.root)
    case 'filesystem':
      return listFilesystemManagedMemoryFiles(home.root)
    default:
      return []
  }
}

export function isAllowedManagedRelativePath(
  home: ManagedMemoryHome,
  relativePath: string,
): boolean {
  switch (home.backend) {
    case 'claude-code':
      return isClaudeMemoryPath(relativePath)
    case 'codex':
      return (
        relativePath === 'AGENTS.md' ||
        /^memories\/[^/]+\.md$/i.test(relativePath)
      )
    case 'filesystem':
      return isGenericManagedMemoryPath(relativePath)
    default:
      return false
  }
}

export function readCodexVirtualMemory(
  home: ManagedMemoryHome,
  relativePath: string,
): string | null {
  if (home.backend !== 'codex') return null
  if (relativePath === 'AGENTS.md') return null // real file
  if (!/^memories\/[^/]+\.md$/i.test(relativePath)) return null

  const dbPath = findCodexMemoriesDb(home.root)
  if (!dbPath) throw new Error('Codex memories database not found')

  const { execFileSync } = nodeRequire('node:child_process') as typeof import('node:child_process')
  const targetName = path.basename(relativePath)
  const script = `
import json, sqlite3, os
path = ${JSON.stringify(dbPath)}
target = ${JSON.stringify(targetName)}
con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
cur = con.cursor()
rows = cur.execute(
  """
  SELECT thread_id, raw_memory, rollout_summary, rollout_slug, generated_at
  FROM stage1_outputs
  ORDER BY generated_at DESC
  LIMIT 200
  """
).fetchall()
for thread_id, raw, summary, slug, generated_at in rows:
  body = (raw or summary or "").strip()
  if not body:
    continue
  safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in (slug or thread_id or "memory"))[:80]
  name = f"{safe or thread_id}.md"
  if name != target and f"{thread_id}.md" != target:
    continue
  title = slug or thread_id
  print(f"# Codex memory: {title}\\n\\nthread: {thread_id}\\n\\n{body}")
  raise SystemExit
raise SystemExit("missing")
`
  try {
    return execFileSync('python3', ['-c', script], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/missing|status/.test(message)) {
      throw new Error(`Codex memory not found: ${relativePath}`)
    }
    throw new Error(`Failed to read Codex memory: ${message}`)
  }
}
