import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  isAuthenticated,
  requireLocalOrAuth,
} from '../../server/auth-middleware'
import {
  getClientIp,
  rateLimit,
  rateLimitResponse,
  requireJsonContentType,
  safeErrorMessage,
} from '../../server/rate-limit'
import { resolveActiveWorkspacePath } from './workspace'
import {
  deleteSshPath,
  listSshFileTree,
  mkdirSshPath,
  readSshFile,
  readSshTerminalConfig,
  remotePathIsDirectory,
  renameSshPath,
  writeSshFile,
  zipSshFolder,
} from '../../server/ssh-terminal'
import {
  openLocalPathInEditor,
  openRemoteSshPathInEditor,
  revealLocalPath,
} from '../../server/workspace-os-open'
import {
  MAX_FOLDER_ZIP_BYTES,
  MAX_FOLDER_ZIP_FILES,
  zipLocalFolder,
} from '../../server/workspace-zip'
import {
  readWorkspaceScopeQueryParam,
  remoteWorkspaceContextForScope,
  workspaceProfileScope,
} from '../../server/workspace-profile'
import { ensureRemoteWorkspacePath } from '../../server/workspace-remote'

const execFileAsync = promisify(execFile)

type FileEntry = {
  name: string
  path: string
  type: 'file' | 'folder'
  size?: number
  modifiedAt?: string
  children?: Array<FileEntry>
}

/**
 * Resolve an input path and verify it stays within WORKSPACE_ROOT.
 *
 * Uses path.relative() rather than a string-prefix check (which is unsafe
 * for sibling paths like `/root/.claude` vs `/root/.claude2`). The relative
 * form rejects any candidate that escapes the root via `..` segments or
 * that resolves to an absolute path outside the root. See #121.
 */
async function getWorkspaceRoot(profileName?: string): Promise<string> {
  return resolveActiveWorkspacePath(profileName)
}

function getRemoteSshContext(profileName?: string) {
  const scope = workspaceProfileScope(profileName)
  const remote = remoteWorkspaceContextForScope(scope)
  if (!remote) return null
  const backend = String(
    (remote.config.terminal as Record<string, unknown> | undefined)?.backend ??
      '',
  )
    .trim()
    .toLowerCase()
  if (backend !== 'ssh') return null
  const ssh = readSshTerminalConfig(remote.config)
  if (!ssh) return null
  return { ...remote, ssh, scope }
}

function toRemoteRelative(resolvedPath: string, workspaceRoot: string) {
  if (resolvedPath === workspaceRoot) return ''
  return path.posix.relative(workspaceRoot, resolvedPath)
}

function ensureWorkspacePath(input: string, workspaceRoot: string) {
  const raw = input.trim()
  if (!raw) return workspaceRoot
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(workspaceRoot, raw)
  if (resolved === workspaceRoot) return resolved
  const relative = path.relative(workspaceRoot, resolved)
  if (
    !relative ||
    relative.startsWith('..') ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Path is outside workspace')
  }
  return resolved
}

function toRelative(resolvedPath: string, workspaceRoot: string) {
  const relative = path.relative(workspaceRoot, resolvedPath)
  return relative || ''
}

function sortEntries(entries: Array<FileEntry>) {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function normalizePathForGlob(input: string) {
  return input.replace(/\\/g, '/')
}

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasGlob(input: string) {
  return input.includes('*')
}

function parseGlobPattern(input: string) {
  const normalized = normalizePathForGlob(input.trim())
  const lastSlashIndex = normalized.lastIndexOf('/')
  const directoryPath =
    lastSlashIndex >= 0 ? normalized.slice(0, lastSlashIndex) : ''
  const filePattern =
    lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized

  const regexSource = `^${escapeRegex(filePattern).replace(/\\\*/g, '.*')}$`

  return {
    directoryPath,
    regex: new RegExp(regexSource),
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'dist',
  '.DS_Store',
])

const MAX_DIRECTORY_DEPTH = 3
const MAX_DIRECTORY_ENTRIES = 20_000

type ReadDirectoryOptions = {
  maxDepth: number
  maxEntries: number | null
  countedEntries: { value: number }
  workspaceRoot: string
}

function parseMaxDepth(input: string | null): number | null {
  if (!input) return null
  const parsed = Number(input)
  if (!Number.isFinite(parsed)) return null
  return Math.min(MAX_DIRECTORY_DEPTH, Math.max(0, Math.floor(parsed)))
}

function parseMaxEntries(input: string | null): number | null {
  if (!input) return null
  const parsed = Number(input)
  if (!Number.isFinite(parsed)) return null
  return Math.min(MAX_DIRECTORY_ENTRIES, Math.max(1, Math.floor(parsed)))
}

async function readDirectory(
  dirPath: string,
  depth: number,
  options: ReadDirectoryOptions,
): Promise<Array<FileEntry>> {
  if (depth > options.maxDepth) return []
  if (
    options.maxEntries !== null &&
    options.countedEntries.value >= options.maxEntries
  ) {
    return []
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const mapped: Array<FileEntry> = []

  for (const entry of entries) {
    if (
      options.maxEntries !== null &&
      options.countedEntries.value >= options.maxEntries
    ) {
      break
    }

    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)
    const relativePath = toRelative(fullPath, options.workspaceRoot)
    try {
      const stats = await fs.stat(fullPath)
      if (entry.isDirectory()) {
        // At the requested depth limit, list the folder itself but omit
        // children so clients can lazy-load on expand (undefined ≠ empty []).
        if (depth >= options.maxDepth) {
          mapped.push({
            name: entry.name,
            path: relativePath,
            type: 'folder',
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          })
        } else {
          const children = await readDirectory(fullPath, depth + 1, options)
          mapped.push({
            name: entry.name,
            path: relativePath,
            type: 'folder',
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            children,
          })
        }
      } else {
        mapped.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        })
      }
      options.countedEntries.value += 1
    } catch {
      // Skip broken symlinks or inaccessible entries
      continue
    }
  }

  return sortEntries(mapped)
}

async function readGlobDirectory(globPath: string, workspaceRoot: string) {
  const { directoryPath, regex } = parseGlobPattern(globPath)
  const resolvedDirectory = ensureWorkspacePath(directoryPath, workspaceRoot)
  const entries = await fs.readdir(resolvedDirectory, { withFileTypes: true })
  const mapped: Array<FileEntry> = []

  for (const entry of entries) {
    if (!regex.test(entry.name)) continue
    const fullPath = path.join(resolvedDirectory, entry.name)
    const stats = await fs.stat(fullPath)
    mapped.push({
      name: entry.name,
      path: toRelative(fullPath, workspaceRoot),
      type: entry.isDirectory() ? 'folder' : 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    })
  }

  return {
    root: toRelative(resolvedDirectory, workspaceRoot),
    entries: sortEntries(mapped),
  }
}

function getMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.pdf':
      return 'application/pdf'
    case '.md':
    case '.markdown':
      return 'text/markdown; charset=utf-8'
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.csv':
      return 'text/csv; charset=utf-8'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    default:
      return 'application/octet-stream'
  }
}

function isImageFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)
}

export const Route = createFileRoute('/api/files')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const action = url.searchParams.get('action') || 'list'
          const inputPath = url.searchParams.get('path') || ''
          const maxDepthParam = parseMaxDepth(url.searchParams.get('maxDepth'))
          const maxEntriesParam = parseMaxEntries(
            url.searchParams.get('maxEntries'),
          )
          const profile = readWorkspaceScopeQueryParam(request)

          const workspaceRoot = await getWorkspaceRoot(profile)
          const remote = getRemoteSshContext(profile)

          if (remote) {
            if (action === 'list' && hasGlob(inputPath)) {
              return json(
                {
                  error:
                    'Glob listing is not supported over SSH. Open a folder instead.',
                },
                { status: 501 },
              )
            }
            const resolvedPath = inputPath.trim()
              ? path.posix.normalize(
                  inputPath.startsWith('/')
                    ? inputPath
                    : path.posix.join(workspaceRoot, inputPath),
                )
              : workspaceRoot

            if (action === 'abspath') {
              const abs = inputPath.trim()
                ? path.posix.normalize(
                    inputPath.startsWith('/')
                      ? inputPath
                      : path.posix.join(workspaceRoot, inputPath),
                  )
                : workspaceRoot
              return json({
                ok: true,
                path: abs,
                remote: true,
              })
            }

            if (action === 'download-folder') {
              try {
                const zipBuf = await zipSshFolder({
                  config: remote.config,
                  workspaceRoot,
                  folderPath: resolvedPath,
                  maxFiles: MAX_FOLDER_ZIP_FILES,
                  maxBytes: MAX_FOLDER_ZIP_BYTES,
                })
                const zipName = `${path.posix.basename(resolvedPath) || 'workspace'}.zip`
                return new Response(new Uint8Array(zipBuf), {
                  headers: {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="${zipName}"`,
                    'Cache-Control': 'no-store',
                  },
                })
              } catch (err) {
                const code =
                  err && typeof err === 'object' && 'code' in err
                    ? String((err as { code?: string }).code || '')
                    : ''
                if (code === 'MAX_FILES' || code === 'MAX_BYTES') {
                  return json({ error: safeErrorMessage(err) }, { status: 413 })
                }
                return json({ error: safeErrorMessage(err) }, { status: 500 })
              }
            }

            if (action === 'read') {
              const buffer = await readSshFile({
                config: remote.config,
                workspaceRoot,
                filePath: resolvedPath,
              })
              if (isImageFile(resolvedPath)) {
                const mime = getMimeType(resolvedPath)
                return json({
                  type: 'image',
                  path: toRemoteRelative(resolvedPath, workspaceRoot),
                  content: `data:${mime};base64,${buffer.toString('base64')}`,
                })
              }
              return json({
                type: 'text',
                path: toRemoteRelative(resolvedPath, workspaceRoot),
                content: buffer.toString('utf8'),
              })
            }

            if (action === 'download' || action === 'view') {
              const buffer = await readSshFile({
                config: remote.config,
                workspaceRoot,
                filePath: resolvedPath,
              })
              const mime = getMimeType(resolvedPath)
              const headers: Record<string, string> = {
                'Content-Type':
                  action === 'view' && mime === 'application/octet-stream'
                    ? 'text/plain; charset=utf-8'
                    : mime,
              }
              if (action === 'download') {
                headers['Content-Disposition'] =
                  `attachment; filename="${path.posix.basename(resolvedPath)}"`
              }
              return new Response(buffer, { headers })
            }

            const tree = await listSshFileTree({
              config: remote.config,
              workspaceRoot,
              dirPath: resolvedPath,
              maxDepth: maxDepthParam ?? MAX_DIRECTORY_DEPTH,
            })
            return json({
              root: toRemoteRelative(resolvedPath, workspaceRoot),
              base: workspaceRoot,
              remote: true,
              entries: tree,
            })
          }

          if (action === 'list' && hasGlob(inputPath)) {
            const globListing = await readGlobDirectory(
              inputPath,
              workspaceRoot,
            )
            return json({
              root: globListing.root,
              base: workspaceRoot,
              entries: globListing.entries,
            })
          }

          const resolvedPath = ensureWorkspacePath(inputPath, workspaceRoot)

          if (action === 'abspath') {
            return json({
              ok: true,
              path: resolvedPath,
              remote: false,
            })
          }

          if (action === 'download-folder') {
            try {
              const zipBuf = await zipLocalFolder(resolvedPath)
              const zipName = `${path.basename(resolvedPath) || 'workspace'}.zip`
              return new Response(zipBuf, {
                headers: {
                  'Content-Type': 'application/zip',
                  'Content-Disposition': `attachment; filename="${zipName}"`,
                  'Cache-Control': 'no-store',
                },
              })
            } catch (err) {
              const code =
                err && typeof err === 'object' && 'code' in err
                  ? String((err as { code?: string }).code || '')
                  : ''
              if (code === 'MAX_FILES' || code === 'MAX_BYTES') {
                return json({ error: safeErrorMessage(err) }, { status: 413 })
              }
              throw err
            }
          }

          if (action === 'read') {
            const buffer = await fs.readFile(resolvedPath)
            if (isImageFile(resolvedPath)) {
              const mime = getMimeType(resolvedPath)
              return json({
                type: 'image',
                path: toRelative(resolvedPath, workspaceRoot),
                content: `data:${mime};base64,${buffer.toString('base64')}`,
              })
            }
            return json({
              type: 'text',
              path: toRelative(resolvedPath, workspaceRoot),
              content: buffer.toString('utf8'),
            })
          }

          if (action === 'download' || action === 'view') {
            const buffer = await fs.readFile(resolvedPath)
            const mime = getMimeType(resolvedPath)
            const headers: Record<string, string> = {
              'Content-Type':
                action === 'view' && mime === 'application/octet-stream'
                  ? 'text/plain; charset=utf-8'
                  : mime,
            }
            if (action === 'download') {
              headers['Content-Disposition'] =
                `attachment; filename="${path.basename(resolvedPath)}"`
            }
            return new Response(buffer, { headers })
          }

          const tree = await readDirectory(resolvedPath, 0, {
            maxDepth: maxDepthParam ?? MAX_DIRECTORY_DEPTH,
            maxEntries: maxEntriesParam,
            countedEntries: { value: 0 },
            workspaceRoot,
          })
          return json({
            root: toRelative(resolvedPath, workspaceRoot),
            base: workspaceRoot,
            entries: tree,
          })
        } catch (err) {
          return json({ error: safeErrorMessage(err) }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const ip = getClientIp(request)
        if (!rateLimit(`files:${ip}`, 30, 60_000)) {
          return rateLimitResponse()
        }

        try {
          const profile = readWorkspaceScopeQueryParam(request)
          const workspaceRoot = await getWorkspaceRoot(profile)
          const remote = getRemoteSshContext(profile)
          const contentType = request.headers.get('content-type') || ''
          if (!contentType.includes('multipart/form-data')) {
            const csrfCheck = requireJsonContentType(request)
            if (csrfCheck) return csrfCheck
          }
          if (remote) {
            if (contentType.includes('multipart/form-data')) {
              const form = await request.formData()
              const action = String(form.get('action') || 'upload')
              if (action !== 'upload') {
                return json(
                  { error: 'Invalid upload request' },
                  { status: 400 },
                )
              }
              const file = form.get('file')
              const targetPath = String(form.get('path') || '')
              const relativePath = String(
                form.get('relativePath') || '',
              ).replace(/^[/\\]+/, '')
              if (!(file instanceof File)) {
                return json({ error: 'Missing file' }, { status: 400 })
              }
              let destination: string
              if (relativePath) {
                destination = targetPath
                  ? path.posix.join(targetPath, relativePath)
                  : relativePath
              } else {
                destination = targetPath.endsWith('/')
                  ? path.posix.join(targetPath, path.posix.basename(file.name))
                  : targetPath || path.posix.join(workspaceRoot, file.name)
              }
              const buffer = Buffer.from(await file.arrayBuffer())
              await writeSshFile({
                config: remote.config,
                workspaceRoot,
                filePath: destination,
                content: buffer,
              })
              return json({
                ok: true,
                path: toRemoteRelative(
                  destination.startsWith('/')
                    ? destination
                    : path.posix.join(workspaceRoot, destination),
                  workspaceRoot,
                ),
              })
            }

            const body = (await request.json().catch(() => ({}))) as Record<
              string,
              unknown
            >
            const action =
              typeof body.action === 'string' ? body.action : 'write'
            if (action === 'reveal') {
              const abs = ensureRemoteWorkspacePath(
                String(body.path || ''),
                workspaceRoot,
              )
              return json({
                ok: true,
                mode: 'clipboard',
                path: abs,
                remote: true,
              })
            }
            if (action === 'open-vscode') {
              const abs = ensureRemoteWorkspacePath(
                String(body.path || ''),
                workspaceRoot,
              )
              const isDirectory = await remotePathIsDirectory({
                config: remote.config,
                workspaceRoot,
                targetPath: abs,
              })
              await openRemoteSshPathInEditor({
                host: remote.ssh.host,
                user: remote.ssh.user,
                remotePath: abs,
                isDirectory,
              })
              return json({
                ok: true,
                path: toRemoteRelative(abs, workspaceRoot),
                remote: true,
              })
            }
            if (action === 'mkdir') {
              const dirPath = String(body.path || '')
              await mkdirSshPath({
                config: remote.config,
                workspaceRoot,
                dirPath,
              })
              return json({ ok: true, path: dirPath })
            }
            if (action === 'rename') {
              await renameSshPath({
                config: remote.config,
                workspaceRoot,
                from: String(body.from || ''),
                to: String(body.to || ''),
              })
              return json({ ok: true, path: String(body.to || '') })
            }
            if (action === 'delete') {
              if (!requireLocalOrAuth(request)) {
                return json(
                  { ok: false, error: 'Unauthorized' },
                  { status: 401 },
                )
              }
              await deleteSshPath({
                config: remote.config,
                workspaceRoot,
                targetPath: String(body.path || ''),
              })
              return json({ ok: true })
            }
            await writeSshFile({
              config: remote.config,
              workspaceRoot,
              filePath: String(body.path || ''),
              content: typeof body.content === 'string' ? body.content : '',
            })
            return json({ ok: true, path: String(body.path || '') })
          }
          if (contentType.includes('multipart/form-data')) {
            const form = await request.formData()
            const action = String(form.get('action') || 'upload')
            if (action !== 'upload') {
              return json({ error: 'Invalid upload request' }, { status: 400 })
            }
            const file = form.get('file')
            const targetPath = String(form.get('path') || '')
            const relativePath = String(form.get('relativePath') || '').replace(
              /^[/\\]+/,
              '',
            )
            if (!(file instanceof File)) {
              return json({ error: 'Missing file' }, { status: 400 })
            }
            const resolvedTarget = ensureWorkspacePath(
              targetPath,
              workspaceRoot,
            )
            let destination: string
            if (relativePath) {
              destination = ensureWorkspacePath(
                path.join(
                  toRelative(resolvedTarget, workspaceRoot),
                  relativePath,
                ),
                workspaceRoot,
              )
            } else {
              const isDir = (await fs.stat(resolvedTarget)).isDirectory()
              destination = isDir
                ? path.join(resolvedTarget, path.basename(file.name))
                : resolvedTarget
              ensureWorkspacePath(destination, workspaceRoot)
            }
            await fs.mkdir(path.dirname(destination), { recursive: true })
            const buffer = Buffer.from(await file.arrayBuffer())
            await fs.writeFile(destination, buffer)
            return json({
              ok: true,
              path: toRelative(destination, workspaceRoot),
            })
          }

          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >
          const action = typeof body.action === 'string' ? body.action : 'write'

          if (action === 'reveal') {
            const targetPath = ensureWorkspacePath(
              String(body.path || ''),
              workspaceRoot,
            )
            await revealLocalPath(targetPath)
            return json({
              ok: true,
              path: toRelative(targetPath, workspaceRoot),
            })
          }

          if (action === 'open-vscode') {
            const targetPath = ensureWorkspacePath(
              String(body.path || ''),
              workspaceRoot,
            )
            await openLocalPathInEditor(targetPath)
            return json({
              ok: true,
              path: toRelative(targetPath, workspaceRoot),
            })
          }

          if (action === 'mkdir') {
            const dirPath = ensureWorkspacePath(
              String(body.path || ''),
              workspaceRoot,
            )
            await fs.mkdir(dirPath, { recursive: true })
            return json({ ok: true, path: toRelative(dirPath, workspaceRoot) })
          }

          if (action === 'rename') {
            const fromPath = ensureWorkspacePath(
              String(body.from || ''),
              workspaceRoot,
            )
            const toPath = ensureWorkspacePath(
              String(body.to || ''),
              workspaceRoot,
            )
            await fs.mkdir(path.dirname(toPath), { recursive: true })
            await fs.rename(fromPath, toPath)
            return json({ ok: true, path: toRelative(toPath, workspaceRoot) })
          }

          if (action === 'delete') {
            if (!requireLocalOrAuth(request)) {
              return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
            }
            const targetPath = ensureWorkspacePath(
              String(body.path || ''),
              workspaceRoot,
            )
            try {
              // Try macOS trash command first
              await execFileAsync('trash', [targetPath])
            } catch {
              // Fallback to rm -rf if trash is not available
              await fs.rm(targetPath, { recursive: true, force: true })
            }
            return json({ ok: true })
          }

          const filePath = ensureWorkspacePath(
            String(body.path || ''),
            workspaceRoot,
          )
          const content = typeof body.content === 'string' ? body.content : ''
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, content, 'utf8')
          return json({ ok: true, path: toRelative(filePath, workspaceRoot) })
        } catch (err) {
          return json({ error: safeErrorMessage(err) }, { status: 500 })
        }
      },
    },
  },
})
