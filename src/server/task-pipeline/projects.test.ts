import { describe, expect, it } from 'vitest'
import {
  assertServerNotInWorktreeRoot,
  getProject,
  loadProjectsFile,
} from './projects'

describe('projects.yaml loader (P2b)', () => {
  it('rejects missing repo', () => {
    expect(() =>
      loadProjectsFile({
        rawYaml: `version: 1\nprojects:\n  - id: bad\n    worktreeRoot: /tmp/wt`,
      }),
    ).toThrow(/repo is required/)
  })

  it('rejects "." as repo', () => {
    expect(() =>
      loadProjectsFile({
        rawYaml: `version: 1\nprojects:\n  - id: bad\n    repo: "."\n    worktreeRoot: /tmp/wt`,
      }),
    ).toThrow(/repo cannot be "."/)
  })

  it('rejects worktreeRoot inside repo', () => {
    expect(() =>
      loadProjectsFile({
        rawYaml: `version: 1\nprojects:\n  - id: bad\n    repo: /tmp/repo\n    worktreeRoot: /tmp/repo/wt`,
      }),
    ).toThrow(/worktreeRoot .* must be outside the repo/)
  })

  it('rejects non-absolute repo path', () => {
    expect(() =>
      loadProjectsFile({
        rawYaml: `version: 1\nprojects:\n  - id: bad\n    repo: relative/path\n    worktreeRoot: /tmp/wt`,
      }),
    ).toThrow(/repo must be an absolute path/)
  })

  it('loads selfHosted project', () => {
    const repo = process.cwd()
    const file = loadProjectsFile({
      repoRoot: repo,
      rawYaml: `version: 1\nprojects:\n  - id: self\n    repo: ${repo}\n    selfHosted: true\n    worktreeRoot: /tmp/wt-self`,
    })
    expect(file.projects[0].selfHosted).toBe(true)
  })
})
