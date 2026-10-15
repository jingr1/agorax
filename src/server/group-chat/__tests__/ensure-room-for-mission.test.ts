/** @vitest-environment node */
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCollabDbForTests } from '../room-store'

vi.mock('../../swarm-missions', () => ({
  getSwarmMission: vi.fn(),
  updateMissionRoomId: vi.fn(),
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
  ensureMissionWorktree: vi.fn(async (project: { worktreeRoot: string }, missionId: string) => ({
    ctx: {
      locality: 'local',
      cwd: path.join(project.worktreeRoot, missionId),
    },
    baseRef: 'abc123',
    setupOutput: '',
  })),
}))

vi.mock('../../agent-runtime/router', () => ({
  getAgentRuntimeRouter: () => ({
    registry: {
      agents: [
        {
          id: 'developer',
          runtime: 'hermes',
          profile: 'developer',
          displayName: 'developer',
          mentionName: 'developer',
        },
      ],
    },
  }),
}))

import { getSwarmMission } from '../../swarm-missions'
import { getProject } from '../../task-pipeline/projects'
import { ensureMissionWorktree } from '../../git-ops'
import { ensureRoomForMission } from '../ensure-room-for-mission'
import { findRoomByMissionId, listParticipants } from '../room-store'

describe('ensureRoomForMission', () => {
  let dbPath: string
  let prevCollab: string | undefined

  beforeEach(() => {
    dbPath = resetCollabDbForTests()
    prevCollab = process.env.HERMES_COLLAB_DB
    process.env.HERMES_COLLAB_DB = dbPath
    vi.mocked(getSwarmMission).mockReset()
    vi.mocked(getProject).mockReset()
    vi.mocked(ensureMissionWorktree).mockClear()
  })

  afterEach(() => {
    if (prevCollab === undefined) delete process.env.HERMES_COLLAB_DB
    else process.env.HERMES_COLLAB_DB = prevCollab
  })

  function stubMission() {
    vi.mocked(getSwarmMission).mockReturnValue({
      id: 'mission-1',
      title: 'Ship feature',
      state: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      assignments: [
        {
          id: 'a1',
          workerId: 'developer',
          task: 'build',
          rationale: null,
          dependsOn: [],
          reviewRequired: false,
          state: 'queued',
          dispatchedAt: null,
          completedAt: null,
          reviewedAt: null,
          reviewedBy: null,
          checkpoint: null,
        },
      ],
      events: [],
      projectId: 'p1',
      workspaceMode: 'worktree',
      taskId: 'task-1',
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
  }

  it('creates a room bound to the mission and invites workers', async () => {
    stubMission()
    const result = await ensureRoomForMission({
      missionId: 'mission-1',
      dbPath,
    })
    expect(result.created).toBe(true)
    expect(result.room.missionId).toBe('mission-1')
    expect(result.room.workspacePath).toBe('/worktrees/mission-1')
    expect(result.room.title).toBe('Ship feature')
    expect(ensureMissionWorktree).toHaveBeenCalled()
    const parts = listParticipants(result.room.id, { dbPath })
    expect(parts.map((p) => p.participantId)).toContain('developer')
  })

  it('is idempotent and refreshes workspacePath', async () => {
    stubMission()
    const first = await ensureRoomForMission({
      missionId: 'mission-1',
      dbPath,
    })
    const second = await ensureRoomForMission({
      missionId: 'mission-1',
      dbPath,
    })
    expect(second.created).toBe(false)
    expect(second.room.id).toBe(first.room.id)
    expect(findRoomByMissionId('mission-1', { dbPath })?.id).toBe(first.room.id)
  })

  it('throws when mission is missing', async () => {
    vi.mocked(getSwarmMission).mockReturnValue(null)
    await expect(
      ensureRoomForMission({ missionId: 'nope', dbPath }),
    ).rejects.toThrow(/not found/i)
  })
})
