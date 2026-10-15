/**
 * Shared workspace path policy: blocked system/Hermes-state roots, and
 * home-rooted folder listing for the workspace picker.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getActiveProfileName, readProfile } from './profiles-browser'

export type WorkspaceFolderEntry = {
  name: string
  path: string
  fullPath: string
  readonly?: boolean
}

export type WorkspaceFolderListResponse = {
  base: string
  current: string
  folders: Array<WorkspaceFolderEntry>
  roots?: Array<WorkspaceFolderEntry>
  remote?: boolean
  backend?: string
  host?: string
}

export class WorkspaceFolderAccessError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WorkspaceFolderAccessError'
    this.status = status
  }
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

export function normalizeCandidate(input: string): string {
  return path.resolve(expandHome(input.trim()))
}

export function isPathWithin(targetPath: string, basePath: string): boolean {
  const base = path.resolve(basePath)
  const target = path.resolve(targetPath)
  if (target === base) return true
  const relative = path.relative(base, target)
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function isPathOrChild(parent: string, candidate: string): boolean {
  const normalizedParent = normalizeCandidate(parent)
  const normalizedCandidate = normalizeCandidate(candidate)
  return (
    normalizedCandidate === normalizedParent ||
    pathContains(normalizedParent, normalizedCandidate)
  )
}

function exactBlockedSystemRoots(): Array<string> {
  return ['/', 'C:/']
}

function blockedSystemSubtrees(): Array<string> {
  return [
    '/bin',
    '/sbin',
    '/etc',
    '/usr',
    '/boot',
    '/proc',
    '/sys',
    '/dev',
    '/root',
    '/private/etc',
    '/private/var/db',
    '/private/var/log',
    'C:/Windows',
    'C:/Program Files',
    'C:/Program Files (x86)',
  ]
}

export function isBlockedSystemPath(candidatePath: string): boolean {
  const normalized = normalizeCandidate(candidatePath)
  return (
    exactBlockedSystemRoots().some(
      (root) => normalizeCandidate(root) === normalized,
    ) || blockedSystemSubtrees().some((root) => isPathOrChild(root, normalized))
  )
}

function activeProfileHome(): string {
  try {
    const active = getActiveProfileName()
    return readProfile(active).path
  } catch {
    return (
      process.env.HERMES_HOME ??
      process.env.HERMES_HOME ??
      path.join(os.homedir(), '.hermes')
    )
  }
}

let hermesStateRootsCache: { roots: Array<string>; at: number } | null = null
const HERMES_STATE_ROOTS_TTL_MS = 5_000

/** Test hook: flush the cached state roots (tests swap HERMES_HOME per case). */
export function __resetHermesStateRootsForTests(): void {
  hermesStateRootsCache = null
}

function hermesStateRoots(): Array<string> {
  const now = Date.now()
  if (
    hermesStateRootsCache &&
    now - hermesStateRootsCache.at < HERMES_STATE_ROOTS_TTL_MS
  ) {
    return hermesStateRootsCache.roots
  }
  const roots = Array.from(
    new Set(
      [
        process.env.HERMES_HOME,
        process.env.HERMES_HOME,
        path.join(os.homedir(), '.hermes'),
        activeProfileHome(),
      ]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .map(normalizeCandidate),
    ),
  )
  hermesStateRootsCache = { roots, at: now }
  return roots
}

export function isHermesStatePath(candidatePath: string): boolean {
  const normalized = normalizeCandidate(candidatePath)
  return hermesStateRoots().some(
    (root) => normalized === root || pathContains(root, normalized),
  )
}

export function assertWorkspaceAllowed(candidatePath: string): void {
  if (isHermesStatePath(candidatePath)) {
    throw new Error(
      'Hermes profile/state directories cannot be used as workspaces',
    )
  }
  if (isBlockedSystemPath(candidatePath)) {
    throw new Error(
      `System directories cannot be used as workspaces: ${candidatePath}`,
    )
  }
}

export function workspaceBaseOverride(): string {
  return process.env.WORKSPACE_BASE?.trim() || ''
}

export function useWindowsDriveWorkspaceMode(): boolean {
  return process.platform === 'win32' && !workspaceBaseOverride()
}

function windowsDriveRoot(pathValue: string): string | null {
  const match = /^([a-zA-Z]:)[\\/]?$/.exec(pathValue.trim())
  return match ? `${match[1].toUpperCase()}\\` : null
}

export function normalizeWindowsWorkspacePath(
  inputPath: string,
): { base: string; fullPath: string } | null {
  const raw = String(inputPath || '').trim()
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) return null
  const fullPath = path.win32.resolve(raw)
  const root = windowsDriveRoot(path.win32.parse(fullPath).root)
  if (!root) return null
  const rel = path.win32.relative(root, fullPath)
  if (rel.startsWith('..') || path.win32.isAbsolute(rel)) return null
  return { base: root, fullPath }
}

export function workspaceBrowseBase(): string {
  return workspaceBaseOverride() || os.homedir()
}

function toRelativeBrowsePath(fullPath: string, basePath: string): string {
  const relative = path.relative(basePath, fullPath)
  if (!relative) return ''
  return relative.split(path.sep).join('/')
}

async function isSafeListDirectory(
  fullPath: string,
  basePath: string,
): Promise<boolean> {
  try {
    const info = await fs.stat(fullPath)
    if (!info.isDirectory()) return false
    const [realTarget, realBase] = await Promise.all([
      fs.realpath(fullPath),
      fs.realpath(basePath),
    ])
    if (!isPathWithin(realTarget, realBase)) return false
    if (isHermesStatePath(realTarget) || isBlockedSystemPath(realTarget)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

async function listWindowsWorkspaceDrives(): Promise<
  Array<WorkspaceFolderEntry>
> {
  const drives: Array<WorkspaceFolderEntry> = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (!existsSync(root)) continue
    drives.push({
      name: root,
      path: root,
      fullPath: root,
      readonly: true,
    })
  }
  return drives
}

async function listDirectoryEntries(
  fullPath: string,
  basePath: string,
  subPath: string,
  options: { absoluteChildPaths?: boolean } = {},
): Promise<Array<WorkspaceFolderEntry>> {
  const entries = await fs.readdir(fullPath, { withFileTypes: true })
  // Resolve once per listing — isHermesStatePath used to re-read the active
  // profile for every child and stalled the whole Node event loop (~500ms).
  const blockedRoots = hermesStateRoots()
  const folders: Array<WorkspaceFolderEntry> = []

  for (const entry of entries) {
    const entryFullPath = options.absoluteChildPaths
      ? path.win32.join(fullPath, entry.name)
      : path.join(fullPath, entry.name)
    const isSymlink =
      typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()
    const isDir = entry.isDirectory() || isSymlink
    if (!isDir) continue

    if (entry.isDirectory() && !isSymlink) {
      if (!isPathWithin(entryFullPath, basePath)) continue
      const normalized = normalizeCandidate(entryFullPath)
      if (
        blockedRoots.some(
          (root) => normalized === root || pathContains(root, normalized),
        ) ||
        isBlockedSystemPath(entryFullPath)
      ) {
        continue
      }
    } else if (!(await isSafeListDirectory(entryFullPath, basePath))) {
      continue
    }

    const relativePath = options.absoluteChildPaths
      ? entryFullPath
      : subPath
        ? `${subPath.replace(/\\/g, '/')}/${entry.name}`
        : entry.name
    folders.push({
      name: entry.name,
      path: relativePath,
      fullPath: entryFullPath,
    })
  }

  folders.sort((a, b) => a.name.localeCompare(b.name))
  return folders
}

export async function listWorkspaceFolders(
  subPath = '',
): Promise<WorkspaceFolderListResponse> {
  const rawPath = String(subPath || '').trim()

  if (useWindowsDriveWorkspaceMode()) {
    if (!rawPath) {
      const drives = await listWindowsWorkspaceDrives()
      return { base: '', current: '', roots: drives, folders: drives }
    }

    const resolved = normalizeWindowsWorkspacePath(rawPath)
    if (!resolved) {
      throw new WorkspaceFolderAccessError(403, 'Access denied')
    }
    if (!existsSync(resolved.fullPath)) {
      throw new WorkspaceFolderAccessError(404, 'Path not found')
    }
    if (!(await isSafeListDirectory(resolved.fullPath, resolved.base))) {
      throw new WorkspaceFolderAccessError(403, 'Access denied')
    }
    try {
      const folders = await listDirectoryEntries(
        resolved.fullPath,
        resolved.base,
        resolved.fullPath,
        { absoluteChildPaths: true },
      )
      return {
        base: resolved.base,
        current: resolved.fullPath,
        folders,
      }
    } catch (err) {
      if (err instanceof WorkspaceFolderAccessError) throw err
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') {
        throw new WorkspaceFolderAccessError(403, 'Access denied')
      }
      throw err
    }
  }

  const base = workspaceBrowseBase()
  const fullPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(base, rawPath)

  if (!isPathWithin(fullPath, base)) {
    throw new WorkspaceFolderAccessError(403, 'Access denied')
  }
  if (!existsSync(fullPath)) {
    throw new WorkspaceFolderAccessError(404, 'Path not found')
  }
  if (isHermesStatePath(fullPath) || isBlockedSystemPath(fullPath)) {
    throw new WorkspaceFolderAccessError(403, 'Access denied')
  }
  if (!(await isSafeListDirectory(fullPath, base))) {
    throw new WorkspaceFolderAccessError(403, 'Access denied')
  }

  const current = rawPath ? toRelativeBrowsePath(fullPath, base) : ''

  try {
    const folders = await listDirectoryEntries(fullPath, base, current)
    return { base: path.resolve(base), current, folders }
  } catch (err) {
    if (err instanceof WorkspaceFolderAccessError) throw err
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new WorkspaceFolderAccessError(403, 'Access denied')
    }
    throw err
  }
}
