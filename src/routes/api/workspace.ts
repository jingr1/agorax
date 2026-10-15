/**
 * Agorax API.
 *
 * Important distinction: HERMES_HOME / ~/.hermes is Hermes state/config, not the
 * user's project workspace. Workspace resolution intentionally mirrors the
 * Hermes Web UI semantics: active profile config first, then user workspace
 * defaults such as ~/workspace. Never fall back to ~/.hermes as a workspace.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  assertWorkspaceAllowed,
  isBlockedSystemPath,
  isHermesStatePath,
  normalizeCandidate,
} from '../../server/workspace-path-policy'
import {
  profileDefaultRemoteWorkspace,
  remoteTerminalWorkspaceCandidate,
} from '../../server/workspace-remote'
import {
  readWorkspaceScopeQueryParam,
  remoteWorkspaceContextForScope,
  workspaceProfileScope,
  type WorkspaceProfileScope,
} from '../../server/workspace-profile'

type WorkspaceEntry = {
  name: string
  path: string
}

type WorkspaceDetectionResponse = {
  path: string
  folderName: string
  source: string
  isValid: boolean
  workspaces: Array<WorkspaceEntry>
  last: string
  /** Hermes profile name (legacy field; same as agent for most Hermes workers). */
  profile?: string
  /** Agent registry id that owns this catalog. */
  agent?: string
}

type WorkspaceState = {
  workspaces?: Array<WorkspaceEntry>
  last?: string
}

const WORKSPACE_CATALOG_TTL_MS = 3_000
const workspaceCatalogCache = new Map<
  string,
  { at: number; value: WorkspaceDetectionResponse }
>()

function workspaceCatalogCacheKey(profileName?: string | null): string {
  return String(profileName ?? '').trim() || '__active__'
}

export function invalidateWorkspaceCatalogCache(
  profileName?: string | null,
): void {
  if (profileName === undefined || profileName === null) {
    workspaceCatalogCache.clear()
    return
  }
  workspaceCatalogCache.delete(workspaceCatalogCacheKey(profileName))
  workspaceCatalogCache.delete('__active__')
}

function remoteWorkspaceContext(scope: WorkspaceProfileScope): {
  remoteCwd: string
  config: Record<string, unknown>
} | null {
  return remoteWorkspaceContextForScope(scope)
}

function workspaceStateDir(scope: WorkspaceProfileScope): string {
  const home = scope.stateHome || scope.profileHome
  if (!home) {
    throw new Error(
      `No workspace state home for scope ${scope.agentId || scope.profileName}`,
    )
  }
  return path.join(home, 'webui_state')
}

function workspaceStateFile(scope: WorkspaceProfileScope): string {
  return path.join(workspaceStateDir(scope), 'workspaces.json')
}

function lastWorkspaceFile(scope: WorkspaceProfileScope): string {
  return path.join(workspaceStateDir(scope), 'last_workspace.txt')
}

async function readWorkspaceState(
  scope: WorkspaceProfileScope,
): Promise<WorkspaceState> {
  try {
    const raw = await fs.readFile(workspaceStateFile(scope), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed))
      return { workspaces: parsed as Array<WorkspaceEntry> }
    if (parsed && typeof parsed === 'object') return parsed as WorkspaceState
  } catch {
    // No persisted state yet.
  }
  return {}
}

async function writeWorkspaceState(
  scope: WorkspaceProfileScope,
  state: WorkspaceState,
): Promise<void> {
  const stateDir = workspaceStateDir(scope)
  await fs.mkdir(stateDir, { recursive: true })
  await fs.writeFile(
    workspaceStateFile(scope),
    JSON.stringify(
      {
        workspaces: state.workspaces ?? [],
        last: state.last ?? '',
      },
      null,
      2,
    ),
    'utf-8',
  )
  if (state.last) {
    await fs.writeFile(lastWorkspaceFile(scope), `${state.last}\n`, 'utf-8')
  }
}

async function configuredDefaultWorkspace(
  scope: WorkspaceProfileScope,
): Promise<{ path: string; source: string } | null> {
  const remote = remoteWorkspaceContext(scope)
  if (remote) {
    const path = profileDefaultRemoteWorkspace(remote.config, remote.remoteCwd)
    return { path, source: 'config.terminal.cwd' }
  }

  const cfg = scope.config
  const terminal = cfg.terminal
  const terminalCwd =
    terminal && typeof terminal === 'object' && !Array.isArray(terminal)
      ? readString((terminal as Record<string, unknown>).cwd)
      : ''

  return firstValidDirectory([
    { path: process.env.AGORAX_DIR ?? '', source: 'env' },
    { path: process.env.CLAUDE_WORKSPACE_DIR ?? '', source: 'env' },
    { path: process.env.HERMES_WEBUI_DEFAULT_WORKSPACE ?? '', source: 'env' },
    { path: readString(cfg.workspace), source: 'config.workspace' },
    {
      path: readString(cfg.default_workspace),
      source: 'config.default_workspace',
    },
    { path: terminalCwd, source: 'config.terminal.cwd' },
    { path: path.join(os.homedir(), 'workspace'), source: 'home.workspace' },
    { path: path.join(os.homedir(), 'work'), source: 'home.work' },
    {
      path: path.join(os.homedir(), 'workspace'),
      source: 'home.workspace.created',
      create: true,
    },
  ])
}

function extractFolderName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) || 'workspace'
}

async function isValidDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function firstValidDirectory(
  candidates: Array<{ path: string; source: string; create?: boolean }>,
): Promise<{ path: string; source: string } | null> {
  for (const candidate of candidates) {
    const raw = candidate.path.trim()
    if (!raw || raw === '.') continue
    const resolved = normalizeCandidate(raw)
    if (candidate.create) {
      try {
        await fs.mkdir(resolved, { recursive: true })
      } catch {
        // Continue to next candidate.
      }
    }
    if (isHermesStatePath(resolved) || isBlockedSystemPath(resolved)) continue
    if (await isValidDirectory(resolved)) {
      return { path: resolved, source: candidate.source }
    }
  }
  return null
}

function dedupeWorkspaces(
  workspaces: Array<WorkspaceEntry>,
): Array<WorkspaceEntry> {
  const seen = new Set<string>()
  const cleaned: Array<WorkspaceEntry> = []
  for (const workspace of workspaces) {
    const rawPath = readString(workspace.path)
    if (!rawPath) continue
    const normalized = normalizeCandidate(rawPath)
    if (isHermesStatePath(normalized) || isBlockedSystemPath(normalized))
      continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const name = readString(workspace.name) || extractFolderName(normalized)
    cleaned.push({ name: name === 'default' ? 'Home' : name, path: normalized })
  }
  return cleaned
}

async function cleanExistingWorkspaces(
  workspaces: Array<WorkspaceEntry>,
  remoteCwd?: string,
): Promise<Array<WorkspaceEntry>> {
  const cleaned = dedupeWorkspaces(workspaces)
  const existing: Array<WorkspaceEntry> = []
  for (const workspace of cleaned) {
    if (remoteCwd) {
      const candidate = remoteTerminalWorkspaceCandidate(
        workspace.path,
        remoteCwd,
      )
      if (candidate) {
        existing.push({ ...workspace, path: candidate })
      }
      continue
    }
    if (await isValidDirectory(workspace.path)) existing.push(workspace)
  }
  return existing
}

export async function loadWorkspaceCatalog(
  profileName?: string | null,
): Promise<WorkspaceDetectionResponse> {
  const cacheKey = workspaceCatalogCacheKey(profileName)
  const cached = workspaceCatalogCache.get(cacheKey)
  if (cached && Date.now() - cached.at < WORKSPACE_CATALOG_TTL_MS) {
    return cached.value
  }

  const value = await loadWorkspaceCatalogUncached(profileName)
  workspaceCatalogCache.set(cacheKey, { at: Date.now(), value })
  return value
}

async function loadWorkspaceCatalogUncached(
  profileName?: string | null,
): Promise<WorkspaceDetectionResponse> {
  const scope = workspaceProfileScope(profileName)
  const remote = remoteWorkspaceContext(scope)
  const remoteCwd = remote?.remoteCwd
  const state = await readWorkspaceState(scope)

  const savedLast = readString(state.last)
  const lastFromFile = await (async () => {
    try {
      return (await fs.readFile(lastWorkspaceFile(scope), 'utf-8')).trim()
    } catch {
      return ''
    }
  })()

  // Fast path (local): if we already have a valid last workspace, skip the
  // expensive firstValidDirectory candidate walk used by configuredDefaultWorkspace.
  if (!remoteCwd) {
    for (const raw of [savedLast, lastFromFile]) {
      if (!raw) continue
      const normalized = normalizeCandidate(raw)
      if (isHermesStatePath(normalized) || isBlockedSystemPath(normalized)) {
        continue
      }
      if (!(await isValidDirectory(normalized))) continue

      let workspaces = await cleanExistingWorkspaces(
        state.workspaces ?? [],
        remoteCwd,
      )
      if (!workspaces.some((workspace) => workspace.path === normalized)) {
        workspaces = [
          {
            name: extractFolderName(normalized),
            path: normalized,
          },
          ...workspaces,
        ]
      }
      if (workspaces.length === 0) {
        workspaces = [{ name: 'Home', path: normalized }]
      }

      return {
        path: normalized,
        folderName:
          workspaces.find((workspace) => workspace.path === normalized)?.name ||
          extractFolderName(normalized),
        source: 'workspace-state',
        isValid: true,
        workspaces,
        last: normalized,
        profile: scope.profileName,
        agent: scope.agentId,
      }
    }
  }

  const configured = await configuredDefaultWorkspace(scope)
  const fallback = configured ?? { path: '', source: 'none' }
  let workspaces = await cleanExistingWorkspaces(
    state.workspaces ?? [],
    remoteCwd,
  )

  if (workspaces.length === 0 && fallback.path) {
    workspaces = [{ name: 'Home', path: fallback.path }]
  }

  // Priority 2: Environment variable (local profiles only — env paths are host-side)
  if (!remoteCwd) {
    const envWorkspace =
      process.env.AGORAX_DIR?.trim() ||
      process.env.CLAUDE_WORKSPACE_DIR?.trim()
    if (envWorkspace) {
      const isValid = await isValidDirectory(envWorkspace)
      if (isValid) {
        return {
          path: envWorkspace,
          folderName: extractFolderName(envWorkspace),
          source: 'env',
          isValid: true,
          workspaces,
          last: envWorkspace,
          profile: scope.profileName,
          agent: scope.agentId,
        }
      }
    }
  }

  const resolveLastCandidate = (raw: string): string => {
    if (!raw) return ''
    if (remoteCwd) {
      return remoteTerminalWorkspaceCandidate(raw, remoteCwd) ?? ''
    }
    const normalized = normalizeCandidate(raw)
    return normalized
  }

  const lastCandidate =
    [savedLast, lastFromFile, fallback.path]
      .map(resolveLastCandidate)
      .find(Boolean) ?? ''

  const activeWorkspace =
    workspaces.find((workspace) => workspace.path === lastCandidate) ??
    workspaces.at(0)
  const active =
    activeWorkspace ??
    (fallback.path ? { name: 'Home', path: fallback.path } : undefined)
  const activePath = active ? active.path : ''

  return {
    path: activePath,
    folderName: active ? active.name || extractFolderName(active.path) : '',
    source:
      activePath && activePath === fallback.path
        ? fallback.source
        : 'workspace-state',
    isValid: Boolean(activePath),
    workspaces,
    last: activePath,
    profile: scope.profileName,
    agent: scope.agentId,
  }
}

export async function resolveActiveWorkspacePath(
  profileName?: string | null,
): Promise<string> {
  const cacheKey = `root:${workspaceCatalogCacheKey(profileName)}`
  const cached = workspaceCatalogCache.get(cacheKey)
  if (cached && Date.now() - cached.at < WORKSPACE_CATALOG_TTL_MS) {
    return cached.value.path
  }

  const scope = workspaceProfileScope(profileName)
  const remote = remoteWorkspaceContext(scope)
  if (remote) {
    const catalog = await loadWorkspaceCatalog(profileName)
    if (!catalog.isValid || !catalog.path) {
      throw new Error('No valid workspace selected')
    }
    return catalog.path
  }

  const state = await readWorkspaceState(scope)
  const savedLast = readString(state.last)
  let lastFromFile = ''
  try {
    lastFromFile = (await fs.readFile(lastWorkspaceFile(scope), 'utf-8')).trim()
  } catch {
    // no last file yet
  }

  for (const raw of [savedLast, lastFromFile]) {
    if (!raw) continue
    const normalized = normalizeCandidate(raw)
    if (isHermesStatePath(normalized) || isBlockedSystemPath(normalized)) {
      continue
    }
    if (!(await isValidDirectory(normalized))) continue
    workspaceCatalogCache.set(cacheKey, {
      at: Date.now(),
      value: {
        path: normalized,
        folderName: extractFolderName(normalized),
        source: 'workspace-state',
        isValid: true,
        workspaces: [{ name: 'Home', path: normalized }],
        last: normalized,
        profile: scope.profileName,
        agent: scope.agentId,
      },
    })
    return normalized
  }

  const catalog = await loadWorkspaceCatalog(profileName)
  if (!catalog.isValid || !catalog.path) {
    throw new Error('No valid workspace selected')
  }
  return catalog.path
}

export async function saveWorkspaceSelection(input: {
  path?: string
  name?: string
  /** Agent registry id (preferred). */
  agent?: string
  /** Legacy Hermes profile / scope key. */
  profile?: string
}): Promise<WorkspaceDetectionResponse> {
  const rawPath = readString(input.path)
  if (!rawPath) throw new Error('path is required')

  const scope = workspaceProfileScope(
    readString(input.agent) || readString(input.profile) || null,
  )
  const remote = remoteWorkspaceContext(scope)
  let target: string
  if (remote) {
    const candidate = remoteTerminalWorkspaceCandidate(
      rawPath,
      remote.remoteCwd,
    )
    if (!candidate) {
      throw new Error(
        `Path is not under the remote terminal working directory (${remote.remoteCwd}): ${rawPath}`,
      )
    }
    target = candidate
    assertWorkspaceAllowed(target)
  } else {
    target = normalizeCandidate(rawPath)
    assertWorkspaceAllowed(target)
    if (!(await isValidDirectory(target))) {
      throw new Error(`Path is not an existing directory: ${target}`)
    }
  }

  const current = await loadWorkspaceCatalog(scope.agentId)
  const next = dedupeWorkspaces([
    ...current.workspaces,
    {
      path: target,
      name:
        readString(input.name) ||
        (current.workspaces.length === 0 ? 'Home' : extractFolderName(target)),
    },
  ])
  await writeWorkspaceState(scope, { workspaces: next, last: target })
  invalidateWorkspaceCatalogCache(scope.agentId)
  invalidateWorkspaceCatalogCache(scope.profileName)
  return loadWorkspaceCatalog(scope.agentId)
}

export const Route = createFileRoute('/api/workspace')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const scopeKey = readWorkspaceScopeQueryParam(request)
          return json(await loadWorkspaceCatalog(scopeKey))
        } catch (err) {
          return json(
            {
              path: '',
              folderName: '',
              source: 'error',
              isValid: false,
              workspaces: [],
              last: '',
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError
        try {
          const body = (await request.json()) as {
            path?: string
            name?: string
            agent?: string
            profile?: string
          }
          // Query-string agent wins over body when both are present.
          const scopeFromQuery = readWorkspaceScopeQueryParam(request)
          return json(
            await saveWorkspaceSelection({
              ...body,
              agent: scopeFromQuery || body.agent,
            }),
          )
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 400 },
          )
        }
      },
    },
  },
})
