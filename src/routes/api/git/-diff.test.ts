import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitStage, ensureMissionWorktree } from '../../../server/git-ops'
import { loadProjectsFile } from '../../../server/task-pipeline/projects'
import { createOrUpdateMission } from '../../../server/swarm-missions'

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# init')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
}

describe('GET /api/git/diff', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'git-diff-route-test-'))
  const repo = join(tmp, 'repo')
  const worktreeRoot = join(tmp, 'worktrees')
  makeRepo(repo)

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns diff for a mission commit range', async () => {
    const project = loadProjectsFile({
      rawYaml: `
version: 1
projects:
  - id: diff-proj
    repo: ${repo}
    defaultBranch: main
    worktreeRoot: ${worktreeRoot}
`,
    }).projects[0]

    const mission = createOrUpdateMission({
      missionId: 'diff-mission',
      title: 'Diff mission',
      projectId: 'diff-proj',
      workspaceMode: 'worktree',
      assignments: [],
    })

    const { ctx, baseRef } = await ensureMissionWorktree(project, mission.id)
    writeFileSync(join(ctx.cwd, 'feature.md'), '# feature')
    const head = await commitStage(ctx, 'add feature')

    const mod = await import('./diff')
    const response = await mod.handleGitDiff(
      new Request(
        `http://localhost/api/git/diff?projectId=diff-proj&missionId=${mission.id}&base=${baseRef}&head=${head}`,
      ),
      {
        getProject: () => project,
        isAuthenticated: () => true,
      },
    )
    const body = await response.json()

    expect(body.diff).toContain('+# feature')
    expect(body.base).toBe(baseRef)
    expect(body.head).toBe(head)
  })
})
