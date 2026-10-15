/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('deleteMission', () => {
  let prevCwd: string
  let prevHermesHome: string | undefined
  let tmp: string

  beforeEach(() => {
    prevCwd = process.cwd()
    prevHermesHome = process.env.HERMES_HOME
    tmp = mkdtempSync(join(tmpdir(), 'delete-mission-'))
    process.env.HERMES_HOME = tmp
    mkdirSync(join(tmp, '.runtime'), { recursive: true })
    writeFileSync(
      join(tmp, 'projects.yaml'),
      `version: 1
projects:
  - id: demo
    repo: ${tmp}
    defaultBranch: main
    worktreeRoot: ${join(tmp, 'worktrees')}
    setup: []
    maxConcurrentWorktrees: 1
    gitRemote: ''
    selfHosted: true
`,
    )
    process.chdir(tmp)
    vi.resetModules()
    vi.doMock('../git-ops', () => ({
      ensureMissionWorktree: vi.fn(),
      releaseMissionWorktree: vi.fn(async () => undefined),
    }))
    vi.doMock('./dispatch-ready', () => ({
      dispatchReadyAssignments: vi.fn(async () => ({
        missionId: 'x',
        dispatched: [],
      })),
    }))
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prevHermesHome
    vi.resetModules()
    vi.doUnmock('../git-ops')
    vi.doUnmock('./dispatch-ready')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('removes mission from store by missionId', async () => {
    const { createOrUpdateMission, getSwarmMission } = await import(
      '../swarm-missions'
    )
    const { deleteMission } = await import('./task-service')

    const mission = createOrUpdateMission({
      title: 'to-delete',
      assignments: [
        {
          workerId: 'researcher',
          task: 'look around',
          rationale: null,
          dependsOn: [],
          reviewRequired: false,
        },
      ],
    })

    const result = await deleteMission(mission.id)
    expect(result.missionId).toBe(mission.id)
    expect(getSwarmMission(mission.id)).toBeNull()
  })
})
