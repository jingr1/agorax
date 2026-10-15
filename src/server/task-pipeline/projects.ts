/**
 * projects — project declarations from projects.yaml (plan P2b).
 *
 * Key fix: target repo must be EXPLICIT. No fallback to process.cwd().
 * The control-plane repo may only be used as a target when selfHosted: true.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import * as YAML from 'yaml'

export type ProjectRemote = {
  host: string
  repo: string
  worktreeRoot: string
  setup: Array<string>
}

export type ProjectDeclaration = {
  id: string
  repo: string
  defaultBranch: string
  worktreeRoot: string
  setup: Array<string>
  maxConcurrentWorktrees: number
  gitRemote: string
  selfHosted: boolean
  remotes: Array<ProjectRemote>
}

export type ProjectsFile = {
  version: number
  projects: Array<ProjectDeclaration>
}

export function getProjectsYamlPath(repoRoot?: string): string {
  return path.join(repoRoot ?? process.cwd(), 'projects.yaml')
}

function resolveMaybeRelative(p: string, base: string): string {
  if (path.isAbsolute(p)) return p
  return path.resolve(base, p)
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

/**
 * Detect the control-plane repo root. Heuristic: directory containing
 * projects.yaml / package.json / src/server, and its own .git.
 */
function detectControlPlaneRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'src', 'server')) &&
      fs.existsSync(path.join(dir, '.git'))
    ) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

export function loadProjectsFile(input?: {
  repoRoot?: string
  rawYaml?: string
}): ProjectsFile {
  const filePath = getProjectsYamlPath(input?.repoRoot)
  const raw =
    input?.rawYaml ??
    (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null)
  if (raw === null) {
    throw new Error(
      'projects.yaml not found. Target repos must be declared explicitly; process.cwd() is no longer used as the canonical repo.',
    )
  }

  const doc = YAML.parse(raw) as {
    version?: number
    projects?: Array<Record<string, unknown>>
  } | null

  const baseDir = input?.repoRoot ?? process.cwd()
  const controlPlaneRoot = detectControlPlaneRoot()
  const errors: Array<string> = []
  const projects: Array<ProjectDeclaration> = []

  for (const entry of doc?.projects ?? []) {
    const id = String(entry.id ?? '')
    if (!id) {
      errors.push('project entry missing id')
      continue
    }

    const rawRepo = entry.repo ? String(entry.repo) : ''
    if (!rawRepo) {
      errors.push(`project ${id}: repo is required`)
      continue
    }
    if (rawRepo === '.') {
      errors.push(`project ${id}: repo cannot be "."; use an absolute path`)
      continue
    }
    if (!path.isAbsolute(rawRepo)) {
      errors.push(`project ${id}: repo must be an absolute path`)
      continue
    }
    const repo = rawRepo

    const selfHosted = entry.selfHosted === true
    if (repo === controlPlaneRoot && !selfHosted) {
      errors.push(
        `project ${id}: repo points to the control-plane root (${controlPlaneRoot}). ` +
          `Set selfHosted: true explicitly to allow agent work on this repo.`,
      )
      continue
    }

    const rawWorktreeRoot = entry.worktreeRoot ? String(entry.worktreeRoot) : ''
    if (!rawWorktreeRoot) {
      errors.push(`project ${id}: worktreeRoot is required`)
      continue
    }
    if (!path.isAbsolute(rawWorktreeRoot)) {
      errors.push(`project ${id}: worktreeRoot must be an absolute path`)
      continue
    }
    const worktreeRoot = rawWorktreeRoot
    if (worktreeRoot.startsWith(repo + path.sep) || worktreeRoot === repo) {
      errors.push(
        `project ${id}: worktreeRoot (${worktreeRoot}) must be outside the repo (${repo})`,
      )
      continue
    }

    if (!isGitRepo(repo)) {
      errors.push(`project ${id}: repo ${repo} is not a git repository`)
      continue
    }

    const setup = Array.isArray(entry.setup) ? entry.setup.map(String) : []
    const maxConcurrentWorktrees =
      typeof entry.maxConcurrentWorktrees === 'number'
        ? entry.maxConcurrentWorktrees
        : 1
    const gitRemote = entry.gitRemote ? String(entry.gitRemote) : ''

    const remotes: Array<ProjectRemote> = []
    if (entry.remotes && typeof entry.remotes === 'object') {
      for (const [host, r] of Object.entries(
        entry.remotes as Record<string, unknown>,
      )) {
        const rr = r as Record<string, unknown>
        const remoteRepo = rr.repo ? String(rr.repo) : ''
        const remoteWorktreeRoot = rr.worktreeRoot
          ? String(rr.worktreeRoot)
          : ''
        if (!remoteRepo || !remoteWorktreeRoot) {
          errors.push(
            `project ${id} remote ${host}: repo and worktreeRoot are required`,
          )
          continue
        }
        remotes.push({
          host,
          repo: remoteRepo,
          worktreeRoot: remoteWorktreeRoot,
          setup: Array.isArray(rr.setup) ? rr.setup.map(String) : setup,
        })
      }
    }

    projects.push({
      id,
      repo,
      defaultBranch: entry.defaultBranch ? String(entry.defaultBranch) : 'main',
      worktreeRoot,
      setup,
      maxConcurrentWorktrees,
      gitRemote,
      selfHosted,
      remotes,
    })
  }

  if (errors.length > 0) {
    throw new Error(
      `projects.yaml validation failed:\n  - ${errors.join('\n  - ')}`,
    )
  }

  return { version: doc?.version ?? 1, projects }
}

export function getProject(
  projectId: string,
  input?: { repoRoot?: string },
): ProjectDeclaration | null {
  return (
    loadProjectsFile(input).projects.find((p) => p.id === projectId) ?? null
  )
}

/**
 * Boot-time self check: ensure the server is not running inside any project's
 * worktreeRoot. Called before listen().
 */
export function assertServerNotInWorktreeRoot(): void {
  const cwd = process.cwd()
  const projects = loadProjectsFile().projects
  for (const p of projects) {
    if (cwd === p.worktreeRoot || cwd.startsWith(p.worktreeRoot + path.sep)) {
      throw new Error(
        `Refusing to start: process.cwd() (${cwd}) is inside project ${p.id} worktreeRoot (${p.worktreeRoot}). ` +
          `Running from inside a mission worktree would cause releaseMissionWorktree to delete the running server tree.`,
      )
    }
    for (const r of p.remotes) {
      if (cwd === r.worktreeRoot || cwd.startsWith(r.worktreeRoot + path.sep)) {
        throw new Error(
          `Refusing to start: process.cwd() (${cwd}) is inside remote worktreeRoot of project ${p.id}/${r.host}.`,
        )
      }
    }
  }
}
