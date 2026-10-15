/**
 * git-ops — per-mission worktree / branch / commit-range operations (plan P2b).
 *
 * All git commands go through a GitContext so the same functions work for
 * local worktrees and ssh-locality remotes. No bare-path overloads.
 *
 * Locality model:
 *   - local: execFile('git', args, { cwd })
 *   - ssh:   execFile('ssh', [host, 'git', '-C', cwd, ...args])
 *
 * ssh locality is read-only consumer only: code is pushed to the remote bare
 * repo / main repo, then a remote worktree is added and checked out. The agent
 * runs inside that remote worktree and rsyncs artifacts back. This keeps the
 * MCP endpoint on the local gateway (127.0.0.1) for hermes runtimes.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { promisify } from 'node:util'
import { SWARM_MEMORY_HANDOFFS, SWARM_MEMORY_ROOT } from './swarm-environment'
import type {
  ProjectDeclaration,
  ProjectRemote,
} from './task-pipeline/projects'

const execFileAsync = promisify(execFile)

export type GitContext =
  | { locality: 'local'; cwd: string }
  | { locality: 'ssh'; host: string; cwd: string }

export type GitResult = {
  stdout: string
  stderr: string
}

const GIT_TIMEOUT_MS = 60_000

function buildGitArgs(ctx: GitContext): {
  cmd: string
  args: Array<string>
  options: { cwd?: string; timeout: number }
} {
  if (ctx.locality === 'local') {
    return {
      cmd: 'git',
      args: [],
      options: { cwd: ctx.cwd, timeout: GIT_TIMEOUT_MS },
    }
  }
  return {
    cmd: 'ssh',
    args: ['-o', 'BatchMode=yes', ctx.host, 'git', '-C', ctx.cwd],
    options: { timeout: GIT_TIMEOUT_MS },
  }
}

export async function gitExec(
  ctx: GitContext,
  args: Array<string>,
): Promise<GitResult> {
  const { cmd, args: baseArgs, options } = buildGitArgs(ctx)
  const { stdout, stderr } = await execFileAsync(
    cmd,
    [...baseArgs, ...args],
    options,
  )
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

function worktreePath(project: ProjectDeclaration, missionId: string): string {
  return path.join(project.worktreeRoot, missionId)
}

function remoteWorktreePath(remote: ProjectRemote, missionId: string): string {
  return path.join(remote.worktreeRoot, missionId)
}

export function localGitContext(
  project: ProjectDeclaration,
  missionId: string,
): GitContext {
  return { locality: 'local', cwd: worktreePath(project, missionId) }
}

export function remoteGitContext(
  remote: ProjectRemote,
  missionId: string,
): GitContext {
  return {
    locality: 'ssh',
    host: remote.host,
    cwd: remoteWorktreePath(remote, missionId),
  }
}

/**
 * Resolve a GitContext for an agent + project + mission.
 * For ssh locality, picks the remote entry whose host matches the agent's
 * terminal.backend ssh_host.
 */
export function gitContextFor(
  project: ProjectDeclaration,
  missionId: string,
  locality: 'local' | 'ssh',
  host?: string,
): GitContext {
  if (locality === 'local') return localGitContext(project, missionId)
  const remote = host
    ? project.remotes.find((r) => r.host === host)
    : project.remotes[0]
  if (!remote)
    throw new Error(
      `project ${project.id} has no remote for host ${host ?? '<default>'}`,
    )
  return remoteGitContext(remote, missionId)
}

/** Get the current HEAD sha. */
export async function resolveHead(ctx: GitContext): Promise<string> {
  const { stdout } = await gitExec(ctx, ['rev-parse', 'HEAD'])
  return stdout
}

/** Diff two refs; returns unified diff text. */
export async function diffRange(
  ctx: GitContext,
  base: string,
  head: string,
  filePath?: string,
): Promise<string> {
  const args = ['diff', `${base}..${head}`]
  if (filePath) args.push('--', filePath)
  const { stdout } = await gitExec(ctx, args)
  return stdout
}

/** List files changed between two refs (repo-relative paths). */
export async function filesChangedBetween(
  ctx: GitContext,
  base: string,
  head: string,
): Promise<Array<string>> {
  const { stdout } = await gitExec(ctx, [
    'diff',
    '--name-only',
    `${base}..${head}`,
  ])
  if (!stdout) return []
  return stdout.split('\n').filter(Boolean)
}

/**
 * Ensure the local worktreeRoot directory exists.
 */
export function ensureWorktreeRoot(project: ProjectDeclaration): void {
  fs.mkdirSync(project.worktreeRoot, { recursive: true })
}

/**
 * Run the project setup commands inside a GitContext.
 * Returns { ok, output } so callers can decide to block the assignment if
 * setup fails (plan: "setup 失败即 blocked 不放 agent 进半装好的树").
 */
export async function runProjectSetup(
  ctx: GitContext,
  setup: Array<string>,
): Promise<{ ok: boolean; output: string }> {
  const outputs: Array<string> = []
  for (const command of setup) {
    const [cmd, ...args] = command.split(' ').filter(Boolean)
    if (!cmd) continue
    try {
      if (ctx.locality === 'local') {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          cwd: ctx.cwd,
          timeout: 300_000,
        })
        if (stdout) outputs.push(stdout)
        if (stderr) outputs.push(stderr)
      } else {
        const { stdout, stderr } = await execFileAsync(
          'ssh',
          [
            '-o',
            'BatchMode=yes',
            ctx.host,
            `cd ${JSON.stringify(ctx.cwd)} && ${command}`,
          ],
          { timeout: 300_000 },
        )
        if (stdout) outputs.push(stdout)
        if (stderr) outputs.push(stderr)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outputs.push(`FAILED: ${command}\n${message}`)
      return { ok: false, output: outputs.join('\n') }
    }
  }
  return { ok: true, output: outputs.join('\n') }
}

/**
 * Ensure a mission worktree exists locally. Idempotent.
 * Runs the local setup on a newly-created worktree.
 * Returns the base ref (HEAD of defaultBranch) that the worktree was created from.
 */
export async function ensureMissionWorktree(
  project: ProjectDeclaration,
  missionId: string,
): Promise<{ ctx: GitContext; baseRef: string; setupOutput: string }> {
  ensureWorktreeRoot(project)
  const wtPath = worktreePath(project, missionId)
  const ctx: GitContext = { locality: 'local', cwd: project.repo }
  let created = false

  if (!fs.existsSync(wtPath)) {
    const branch = `swarm/mission-${missionId}`
    // Ensure branch exists at defaultBranch tip.
    const { stdout: head } = await gitExec(ctx, [
      'rev-parse',
      project.defaultBranch,
    ])
    try {
      await gitExec(ctx, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ])
    } catch {
      await gitExec(ctx, ['branch', branch, head])
    }
    await gitExec(ctx, ['worktree', 'add', wtPath, branch])
    created = true
  }

  const worktreeCtx = localGitContext(project, missionId)
  const baseRef = await resolveHead(worktreeCtx)

  let setupOutput = ''
  if (created && project.setup.length > 0) {
    const setupResult = await runProjectSetup(worktreeCtx, project.setup)
    setupOutput = setupResult.output
    if (!setupResult.ok) {
      throw new Error(
        `Setup failed for mission worktree ${missionId}: ${setupResult.output}`,
      )
    }
  }

  return { ctx: worktreeCtx, baseRef, setupOutput }
}

/**
 * Push the mission branch to a remote host's repo so a remote worktree can
 * check it out. The branch is pushed to the remote repo path declared in
 * projects.yaml remotes.
 */
export async function pushBranchToRemote(
  project: ProjectDeclaration,
  host: string,
  missionId: string,
): Promise<void> {
  const remote = project.remotes.find((r) => r.host === host)
  if (!remote)
    throw new Error(`project ${project.id} has no remote for host ${host}`)
  const localCtx: GitContext = { locality: 'local', cwd: project.repo }
  const branch = `swarm/mission-${missionId}`
  // Push to a mirror remote created ad-hoc; ssh URL uses the remote repo path.
  const remoteUrl = `${host}:${remote.repo}`
  await gitExec(localCtx, ['push', remoteUrl, `${branch}:${branch}`])
}

/**
 * Ensure a remote worktree exists. Assumes pushBranchToRemote has already run.
 * Runs the remote's setup on a newly-created worktree.
 */
export async function ensureRemoteMissionWorktree(
  project: ProjectDeclaration,
  host: string,
  missionId: string,
  baseRef: string,
): Promise<{ ctx: GitContext; setupOutput: string }> {
  const remote = project.remotes.find((r) => r.host === host)
  if (!remote)
    throw new Error(`project ${project.id} has no remote for host ${host}`)
  const ctx = remoteGitContext(remote, missionId)
  let created = false

  try {
    await gitExec(ctx, ['rev-parse', '--git-dir'])
  } catch {
    // worktree does not exist: create it
    await gitExec({ locality: 'ssh', host, cwd: remote.repo }, [
      'worktree',
      'add',
      remote.worktreeRoot + '/' + missionId,
      baseRef,
    ])
    created = true
  }

  let setupOutput = ''
  if (created && remote.setup.length > 0) {
    const setupResult = await runProjectSetup(ctx, remote.setup)
    setupOutput = setupResult.output
    if (!setupResult.ok) {
      throw new Error(
        `Remote setup failed for ${host}/${missionId}: ${setupResult.output}`,
      )
    }
  }

  return { ctx, setupOutput }
}

/** Commit changes in ctx.cwd with the given message. */
export async function commitStage(
  ctx: GitContext,
  message: string,
): Promise<string> {
  try {
    await gitExec(ctx, ['add', '-A'])
  } catch {
    // nothing to add
  }
  try {
    await gitExec(ctx, ['commit', '-m', message])
  } catch {
    // nothing to commit
  }
  return resolveHead(ctx)
}

/**
 * Merge sibling commits into the mission integration branch.
 * Accepts commit shas (from upstream assignments' headSha) rather than branch
 * names so callers don't need to track per-worker branch names.
 * Returns { ok, conflicts, mergedHead } where mergedHead is the new HEAD sha
 * of the integration branch on success.
 */
export async function mergeSiblings(
  project: ProjectDeclaration,
  missionId: string,
  heads: Array<string>,
): Promise<{ ok: boolean; conflicts: Array<string>; mergedHead?: string }> {
  const ctx = localGitContext(project, missionId)
  for (const head of heads) {
    try {
      await gitExec(ctx, [
        'merge',
        '--no-ff',
        '-m',
        `merge ${head.slice(0, 8)}`,
        head,
      ])
    } catch (error) {
      // Capture conflict files before abort clears them.
      let conflicts: Array<string> = []
      try {
        const { stdout } = await gitExec(ctx, [
          'diff',
          '--name-only',
          '--diff-filter=U',
        ])
        conflicts = stdout.split('\n').filter(Boolean)
        if (conflicts.length === 0) {
          const { stdout: ls } = await gitExec(ctx, ['ls-files', '-u'])
          conflicts = Array.from(
            new Set(
              ls
                .split('\n')
                .filter(Boolean)
                .map((line) => line.split(/\s+/)[3]),
            ),
          )
        }
      } catch {
        // ignore
      }
      // merge failed: abort and report conflicts
      try {
        await gitExec(ctx, ['merge', '--abort'])
      } catch {
        // ignore abort errors
      }
      return { ok: false, conflicts }
    }
  }
  const mergedHead = await resolveHead(ctx)
  return { ok: true, conflicts: [], mergedHead }
}

/**
 * Pull artifacts from a remote worktree back to the local memory tree.
 * Returns the destination directory.
 */
export async function pullArtifacts(
  project: ProjectDeclaration,
  host: string,
  missionId: string,
  workerId: string,
): Promise<string> {
  const remote = project.remotes.find((r) => r.host === host)
  if (!remote)
    throw new Error(`project ${project.id} has no remote for host ${host}`)
  const localDest = path.join(
    SWARM_MEMORY_ROOT,
    'memory',
    'swarm',
    'missions',
    missionId,
    workerId,
  )
  fs.mkdirSync(localDest, { recursive: true })
  const src = `${host}:${remoteWorktreePath(remote, missionId)}/`
  await execFileAsync('rsync', ['-a', '--delete', src, localDest + '/'], {
    timeout: 120_000,
  })
  return localDest
}

/** Remove a local mission worktree. */
export async function releaseMissionWorktree(
  project: ProjectDeclaration,
  missionId: string,
): Promise<void> {
  const wtPath = worktreePath(project, missionId)
  if (!fs.existsSync(wtPath)) return
  if (wtPath === process.cwd() || process.cwd().startsWith(wtPath + path.sep)) {
    throw new Error(
      `Refusing to remove mission worktree ${wtPath}: the running server is inside it.`,
    )
  }
  const ctx: GitContext = { locality: 'local', cwd: project.repo }
  try {
    await gitExec(ctx, ['worktree', 'remove', '--force', wtPath])
  } catch {
    // fall through to fs removal
    fs.rmSync(wtPath, { recursive: true, force: true })
  }
}

/** Remove a remote mission worktree. */
export async function releaseRemoteMissionWorktree(
  project: ProjectDeclaration,
  host: string,
  missionId: string,
): Promise<void> {
  const remote = project.remotes.find((r) => r.host === host)
  if (!remote)
    throw new Error(`project ${project.id} has no remote for host ${host}`)
  const ctx: GitContext = { locality: 'ssh', host, cwd: remote.repo }
  const wtPath = remoteWorktreePath(remote, missionId)
  try {
    await gitExec(ctx, ['worktree', 'remove', '--force', wtPath])
  } catch {
    // best effort
  }
}

/** Verify ssh host is reachable without interactive auth. */
export async function probeSshHost(
  host: string,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await execFileAsync('ssh', ['-o', 'BatchMode=yes', host, 'true'], {
      timeout: 10_000,
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
