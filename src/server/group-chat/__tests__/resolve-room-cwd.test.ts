/** @vitest-environment node */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deriveMissionWorkspacePath,
  resolveRoomCwd,
  validateWorkspacePathInput,
} from '../resolve-room-cwd'

vi.mock('../../swarm-missions', () => ({
  getSwarmMission: vi.fn(),
}))

vi.mock('../../task-pipeline/projects', () => ({
  getProject: vi.fn(),
}))

vi.mock('../../git-ops', () => ({
  localGitContext: vi.fn(
    (project: { worktreeRoot: string }, missionId: string) => ({
      locality: 'local',
      cwd: path.join(project.worktreeRoot, missionId),
    }),
  ),
}))

import { getSwarmMission } from '../../swarm-missions'
import { getProject } from '../../task-pipeline/projects'

describe('validateWorkspacePathInput', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-ws-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for empty', () => {
    expect(validateWorkspacePathInput(null)).toBeNull()
    expect(validateWorkspacePathInput('')).toBeNull()
    expect(validateWorkspacePathInput('   ')).toBeNull()
  })

  it('accepts an existing absolute directory', () => {
    expect(validateWorkspacePathInput(dir)).toBe(path.resolve(dir))
  })

  it('rejects a missing path', () => {
    expect(() =>
      validateWorkspacePathInput(path.join(dir, 'nope')),
    ).toThrow(/does not exist/)
  })
})

describe('resolveRoomCwd / deriveMissionWorkspacePath', () => {
  beforeEach(() => {
    vi.mocked(getSwarmMission).mockReset()
    vi.mocked(getProject).mockReset()
  })

  it('prefers explicit workspacePath', () => {
    expect(
      resolveRoomCwd({
        id: 'r1',
        title: 't',
        state: 'active',
        taskId: null,
        missionId: 'm1',
        workspacePath: '/tmp/explicit',
        ownerParticipantId: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBe(path.resolve('/tmp/explicit'))
  })

  it('derives worktree path from mission', () => {
    vi.mocked(getSwarmMission).mockReturnValue({
      id: 'm1',
      title: 'M',
      state: 'running',
      createdAt: 0,
      updatedAt: 0,
      assignments: [],
      events: [],
      projectId: 'p1',
      workspaceMode: 'worktree',
    } as any)
    vi.mocked(getProject).mockReturnValue({
      id: 'p1',
      repo: '/repo',
      worktreeRoot: '/worktrees',
      defaultBranch: 'main',
      setup: [],
      maxConcurrentWorktrees: 2,
      gitRemote: '',
      selfHosted: false,
      remotes: [],
    })
    expect(deriveMissionWorkspacePath('m1')).toBe('/worktrees/m1')
    expect(
      resolveRoomCwd({
        id: 'r1',
        title: 't',
        state: 'active',
        taskId: null,
        missionId: 'm1',
        workspacePath: null,
        ownerParticipantId: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBe('/worktrees/m1')
  })

  it('derives canonical repo path when not worktree', () => {
    vi.mocked(getSwarmMission).mockReturnValue({
      id: 'm2',
      title: 'M',
      state: 'running',
      createdAt: 0,
      updatedAt: 0,
      assignments: [],
      events: [],
      projectId: 'p1',
      workspaceMode: 'canonical',
    } as any)
    vi.mocked(getProject).mockReturnValue({
      id: 'p1',
      repo: '/repo/app',
      worktreeRoot: '/worktrees',
      defaultBranch: 'main',
      setup: [],
      maxConcurrentWorktrees: 2,
      gitRemote: '',
      selfHosted: false,
      remotes: [],
    })
    expect(deriveMissionWorkspacePath('m2')).toBe('/repo/app')
  })

  it('returns null when nothing is set', () => {
    expect(
      resolveRoomCwd({
        id: 'r1',
        title: 't',
        state: 'active',
        taskId: null,
        missionId: null,
        workspacePath: null,
        ownerParticipantId: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBeNull()
  })
})
