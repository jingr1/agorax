import fs from 'node:fs'
import path from 'node:path'
import { loadAgentsRegistry } from './agent-runtime/agents-config'
import {
  getHermesRoot,
  getProfileHermesHome,
  getProfilesDir,
} from './hermes-paths'
import {
  isAllowedManagedRelativePath,
  listManagedMemoryFiles,
  readCodexVirtualMemory,
  resolveManagedMemoryHome,
  type ManagedMemoryHome,
  type MemoryFileMeta as ManagedMemoryFileMeta,
} from './managed-memory'

export type MemoryFileMeta = ManagedMemoryFileMeta

export type MemorySearchMatch = {
  path: string
  line: number
  text: string
}

export type MemoryKind =
  | 'hermes'
  | 'claude-code'
  | 'codex'
  | 'filesystem'
  | 'unsupported'

export type MemoryAgentScope = {
  id: string
  label: string
  root: string | null
  fileCount: number
  memoryKind: MemoryKind
  runtime: string
  /** Short path hint for managed homes (e.g. ~/.claude). */
  rootHint?: string
  writable: boolean
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

function isHermesBrowserMemoryPath(relativePath: string): boolean {
  return (
    relativePath === 'MEMORY.md' ||
    relativePath.startsWith('memory/') ||
    relativePath.startsWith('memories/')
  )
}

/** Normalize agent/profile id. Empty / `default` → shared Hermes root. */
export function normalizeMemoryAgentId(input?: string | null): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed || trimmed === 'default') return 'default'
  if (!AGENT_ID_RE.test(trimmed) || trimmed.includes('..')) {
    throw new Error('Invalid agent id')
  }
  return trimmed
}

/**
 * Hermes memory workspace root.
 * - `default`: Hermes root (`HERMES_HOME` peeled if it points at a profile)
 * - otherwise: `~/.hermes/profiles/<agentId>`
 */
export function getMemoryWorkspaceRoot(agentId?: string | null): string {
  const id = normalizeMemoryAgentId(agentId)
  if (id === 'default') return path.resolve(getHermesRoot())
  return path.resolve(getProfileHermesHome(id))
}

function normalizeRelativeMemoryPath(input: string): string {
  const normalized = input.replace(/\\/g, '/').trim()
  if (!normalized) throw new Error('Path is required')
  if (normalized.startsWith('/'))
    throw new Error('Absolute paths are not allowed')
  if (normalized.includes('..'))
    throw new Error('Path traversal is not allowed')
  if (!normalized.toLowerCase().endsWith('.md'))
    throw new Error('Only Markdown files are allowed')
  return normalized
}

function pushIfMarkdownFile(
  entries: Array<MemoryFileMeta>,
  workspaceRoot: string,
  fullPath: string,
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
  if (!isHermesBrowserMemoryPath(relativePath)) return

  entries.push({
    path: relativePath,
    name: path.basename(fullPath),
    size: stats.size,
    modified: stats.mtime.toISOString(),
  })
}

function shouldSkipDirectory(name: string): boolean {
  return (
    name === '.git' ||
    name === 'node_modules' ||
    name === 'missions' ||
    name === 'episodes' ||
    name === 'handoffs' ||
    name === 'session-snapshots'
  )
}

function walkWorkspaceDir(
  entries: Array<MemoryFileMeta>,
  workspaceRoot: string,
  dirPath: string,
) {
  let dirEntries: Array<string>
  try {
    dirEntries = fs.readdirSync(dirPath)
  } catch {
    return
  }

  for (const name of dirEntries) {
    const fullPath = path.join(dirPath, name)
    let stats: fs.Stats
    try {
      stats = fs.statSync(fullPath)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (shouldSkipDirectory(name)) continue
      walkWorkspaceDir(entries, workspaceRoot, fullPath)
      continue
    }
    pushIfMarkdownFile(entries, workspaceRoot, fullPath)
  }
}

function compareMemoryFiles(a: MemoryFileMeta, b: MemoryFileMeta): number {
  const rank = (p: string) => {
    if (p === 'MEMORY.md' || p === 'CLAUDE.md' || p === 'AGENTS.md') return 0
    if (p.startsWith('memory/') || p.startsWith('memories/')) return 1
    if (p.startsWith('projects/')) return 2
    return 3
  }
  const rankDiff = rank(a.path) - rank(b.path)
  if (rankDiff !== 0) return rankDiff

  const aIsDaily = /^memories?\/\d{4}-\d{2}-\d{2}\.md$/.test(a.path)
  const bIsDaily = /^memories?\/\d{4}-\d{2}-\d{2}\.md$/.test(b.path)
  if (aIsDaily && bIsDaily) return b.path.localeCompare(a.path)

  const modifiedDiff = Date.parse(b.modified) - Date.parse(a.modified)
  if (modifiedDiff !== 0) return modifiedDiff
  return a.path.localeCompare(b.path)
}

function listHermesMemoryFilesInRoot(
  workspaceRoot: string,
): Array<MemoryFileMeta> {
  const results: Array<MemoryFileMeta> = []

  pushIfMarkdownFile(
    results,
    workspaceRoot,
    path.join(workspaceRoot, 'MEMORY.md'),
  )
  for (const subdir of ['memory', 'memories']) {
    walkWorkspaceDir(results, workspaceRoot, path.join(workspaceRoot, subdir))
  }

  results.sort(compareMemoryFiles)
  return results
}

function memoryKindForManaged(
  home: ManagedMemoryHome,
): Exclude<MemoryKind, 'hermes' | 'unsupported'> {
  if (home.backend === 'claude-code') return 'claude-code'
  if (home.backend === 'codex') return 'codex'
  return 'filesystem'
}

function buildHermesScope(id: string, label: string): MemoryAgentScope {
  const root = getMemoryWorkspaceRoot(id)
  const files = listHermesMemoryFilesInRoot(root)
  return {
    id,
    label,
    root,
    fileCount: files.length,
    memoryKind: 'hermes',
    runtime: 'hermes',
    rootHint: id === 'default' ? '~/.hermes' : `~/.hermes/profiles/${id}`,
    writable: true,
  }
}

function buildManagedScope(
  id: string,
  label: string,
  runtime: string,
): MemoryAgentScope {
  const home = resolveManagedMemoryHome(runtime)
  if (!home) {
    return {
      id,
      label,
      root: null,
      fileCount: 0,
      memoryKind: 'unsupported',
      runtime,
      writable: false,
    }
  }
  const files = listManagedMemoryFiles(home)
  files.sort(compareMemoryFiles)
  return {
    id,
    label,
    root: home.root,
    fileCount: files.length,
    memoryKind: memoryKindForManaged(home),
    runtime,
    rootHint: home.hint,
    writable: home.writable,
  }
}

export function resolveMemoryAgentScope(
  agentId?: string | null,
): MemoryAgentScope {
  const id = normalizeMemoryAgentId(agentId)

  try {
    const registry = loadAgentsRegistry()
    const decl = registry.byId.get(id)
    if (decl) {
      if (decl.runtime === 'hermes') {
        const profile = (decl.profile || decl.id).trim() || decl.id
        return buildHermesScope(
          profile === 'default' ? 'default' : profile,
          decl.displayName || decl.name || decl.id,
        )
      }
      return buildManagedScope(
        decl.id,
        decl.displayName || decl.name || decl.id,
        decl.runtime,
      )
    }
    if (registry.orphanProfiles.includes(id) || id === 'default') {
      return buildHermesScope(id, id)
    }
  } catch {
    // fall through
  }

  // Unknown id: treat as Hermes profile path for backcompat.
  return buildHermesScope(id, id)
}

export function listMemoryFiles(agentId?: string | null): Array<MemoryFileMeta> {
  const scope = resolveMemoryAgentScope(agentId)
  if (scope.memoryKind === 'unsupported' || !scope.root) return []

  if (scope.memoryKind === 'hermes') {
    return listHermesMemoryFilesInRoot(scope.root)
  }

  const home = resolveManagedMemoryHome(scope.runtime)
  if (!home) return []
  const files = listManagedMemoryFiles(home)
  files.sort(compareMemoryFiles)
  return files
}

export function listMemoryAgents(): Array<MemoryAgentScope> {
  const byId = new Map<string, MemoryAgentScope>()

  byId.set('default', buildHermesScope('default', 'default'))

  try {
    const registry = loadAgentsRegistry()
    for (const agent of registry.agents) {
      if (agent.runtime === 'hermes') {
        const profile = (agent.profile || agent.id).trim() || agent.id
        if (profile === 'default') continue
        const scope = buildHermesScope(
          profile,
          agent.displayName || agent.name || agent.id,
        )
        byId.set(profile, scope)
        if (agent.id !== profile && !byId.has(agent.id)) {
          byId.set(agent.id, {
            ...scope,
            id: agent.id,
            label: agent.displayName || agent.name || agent.id,
          })
        }
        continue
      }

      byId.set(
        agent.id,
        buildManagedScope(
          agent.id,
          agent.displayName || agent.name || agent.id,
          agent.runtime,
        ),
      )
    }

    for (const orphan of registry.orphanProfiles) {
      if (orphan === 'default' || byId.has(orphan)) continue
      byId.set(orphan, buildHermesScope(orphan, orphan))
    }
  } catch {
    // Fall through to disk profiles if registry load fails.
  }

  const profilesDir = getProfilesDir()
  let entries: Array<fs.Dirent> = []
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true })
  } catch {
    entries = []
  }

  for (const entry of entries) {
    const name = entry.name
    if (name === 'default' || name.startsWith('.')) continue
    if (!AGENT_ID_RE.test(name)) continue
    if (byId.has(name)) continue
    const profilePath = path.join(profilesDir, name)
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(profilePath).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (!isDir) continue
    byId.set(name, buildHermesScope(name, name))
  }

  const agents = Array.from(byId.values())
  agents.sort((a, b) => {
    if (a.id === 'default') return -1
    if (b.id === 'default') return 1
    if (a.memoryKind === 'hermes' && b.memoryKind !== 'hermes') return -1
    if (b.memoryKind === 'hermes' && a.memoryKind !== 'hermes') return 1
    return a.label.localeCompare(b.label)
  })
  return agents
}

export function resolveMemoryFilePath(
  relativePath: string,
  agentId?: string | null,
): {
  fullPath: string
  relativePath: string
  agentId: string
  workspaceRoot: string
  scope: MemoryAgentScope
  virtual: boolean
} {
  const safeRelativePath = normalizeRelativeMemoryPath(relativePath)
  const scope = resolveMemoryAgentScope(agentId)
  if (scope.memoryKind === 'unsupported' || !scope.root) {
    throw new Error(
      `Agent "${scope.id}" (${scope.runtime}) has no browsable memory home`,
    )
  }

  if (scope.memoryKind === 'hermes') {
    if (!isHermesBrowserMemoryPath(safeRelativePath)) {
      throw new Error('Path is not an allowed Hermes memory file')
    }
  } else {
    const home = resolveManagedMemoryHome(scope.runtime)
    if (!home || !isAllowedManagedRelativePath(home, safeRelativePath)) {
      throw new Error('Path is not an allowed managed memory file')
    }
    // Codex sqlite-backed memories are virtual.
    if (
      home.backend === 'codex' &&
      safeRelativePath.startsWith('memories/') &&
      safeRelativePath !== 'AGENTS.md'
    ) {
      return {
        fullPath: path.join(home.root, safeRelativePath),
        relativePath: safeRelativePath,
        agentId: scope.id,
        workspaceRoot: home.root,
        scope,
        virtual: true,
      }
    }
  }

  const workspaceRoot = scope.root
  const fullPath = path.resolve(workspaceRoot, safeRelativePath)
  if (
    fullPath !== workspaceRoot &&
    !fullPath.startsWith(workspaceRoot + path.sep)
  ) {
    throw new Error('Resolved path is outside workspace')
  }
  return {
    fullPath,
    relativePath: safeRelativePath,
    agentId: scope.id,
    workspaceRoot,
    scope,
    virtual: false,
  }
}

export function readMemoryFile(
  relativePath: string,
  agentId?: string | null,
): string {
  const resolved = resolveMemoryFilePath(relativePath, agentId)
  if (resolved.virtual) {
    const home = resolveManagedMemoryHome(resolved.scope.runtime)
    if (!home) throw new Error('Managed memory home missing')
    const virtual = readCodexVirtualMemory(home, resolved.relativePath)
    if (virtual == null) throw new Error('Virtual memory not found')
    return virtual
  }
  return fs.readFileSync(resolved.fullPath, 'utf-8')
}

export function searchMemoryFiles(
  query: string,
  agentId?: string | null,
): Array<MemorySearchMatch> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const matches: Array<MemorySearchMatch> = []
  const files = listMemoryFiles(agentId)

  for (const file of files) {
    let content = ''
    try {
      content = readMemoryFile(file.path, agentId)
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] || ''
      if (!text.toLowerCase().includes(needle)) continue
      matches.push({
        path: file.path,
        line: index + 1,
        text,
      })
      if (matches.length >= 200) return matches
    }
  }

  return matches
}
