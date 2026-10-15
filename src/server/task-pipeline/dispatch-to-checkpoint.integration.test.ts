import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string

async function loadMissions() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'dispatch-checkpoint-test-'))
  mkdirSync(join(tempRoot, '.runtime'), { recursive: true })
  vi.doMock('../swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))
  return import('../swarm-missions')
}

describe('dispatch to checkpoint integration', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../swarm-environment')
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('dispatches ready assignments and records sequential checkpoints', async () => {
    const missions = await loadMissions()

    const mission = missions.createOrUpdateMission({
      missionId: 'dispatch-checkpoint-1',
      title: 'Sequential stages',
      assignments: [
        {
          workerId: 'researcher',
          task: 'Research',
          reviewRequired: false,
          dependsOn: [],
        },
        {
          workerId: 'architect',
          task: 'Design',
          reviewRequired: false,
          dependsOn: [],
        },
        {
          workerId: 'developer',
          task: 'Implement',
          reviewRequired: false,
          dependsOn: [],
        },
      ],
    })

    // All three independent assignments should be ready to dispatch.
    const ready = missions.readyQueuedAssignments(mission.id)
    expect(ready).toHaveLength(3)

    // Dispatch each assignment.
    for (const assignment of mission.assignments) {
      missions.markMissionAssignmentDispatched({
        missionId: mission.id,
        workerId: assignment.workerId,
        task: assignment.task,
      })
    }

    // Record checkpoints for researcher and architect.
    missions.recordMissionCheckpoint({
      missionId: mission.id,
      workerId: 'researcher',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'notes.md',
        commandsRun: 'none',
        result: 'research done',
        blocker: null,
        nextAction: 'design',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: notes.md\nCOMMANDS_RUN: none\nRESULT: research done\nBLOCKER: none\nNEXT_ACTION: design',
      },
    })
    missions.recordMissionCheckpoint({
      missionId: mission.id,
      workerId: 'architect',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'design.md',
        commandsRun: 'none',
        result: 'design done',
        blocker: null,
        nextAction: 'implement',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: design.md\nCOMMANDS_RUN: none\nRESULT: design done\nBLOCKER: none\nNEXT_ACTION: implement',
      },
    })

    const after = missions.getSwarmMission(mission.id)!
    expect(after.state).toBe('running')
    expect(
      after.assignments.filter((a) => a.state === 'checkpointed').length,
    ).toBe(2)
    expect(after.assignments.find((a) => a.workerId === 'developer')!.state).toBe(
      'dispatched',
    )

    // Finish developer; mission should complete.
    const final = missions.recordMissionCheckpoint({
      missionId: mission.id,
      workerId: 'developer',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'code.ts',
        commandsRun: 'npm test',
        result: 'implemented',
        blocker: null,
        nextAction: 'ship',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: code.ts\nCOMMANDS_RUN: npm test\nRESULT: implemented\nBLOCKER: none\nNEXT_ACTION: ship',
      },
    })
    expect(final?._completed).toBe(true)
    expect(missions.getSwarmMission(mission.id)!.state).toBe('done')

    // JSON cache should contain the completed mission.
    const cache = JSON.parse(
      readFileSync(missions.SWARM_MISSIONS_PATH, 'utf8'),
    ) as { missions: Array<{ state: string }> }
    expect(cache.missions[0]!.state).toBe('done')
  })

  it('records a blocked checkpoint and exposes a report', async () => {
    const missions = await loadMissions()

    const mission = missions.createOrUpdateMission({
      missionId: 'dispatch-blocked-1',
      title: 'Blocked mission',
      assignments: [
        {
          workerId: 'developer',
          task: 'Investigate',
          reviewRequired: false,
        },
      ],
    })

    missions.markMissionAssignmentDispatched({
      missionId: mission.id,
      workerId: 'developer',
      task: 'Investigate',
    })

    missions.recordMissionCheckpoint({
      missionId: mission.id,
      workerId: 'developer',
      checkpoint: {
        stateLabel: 'BLOCKED',
        runtimeState: 'blocked',
        checkpointStatus: 'blocked',
        filesChanged: 'none',
        commandsRun: 'none',
        result: null,
        blocker: 'missing dependency',
        nextAction: 'install dependency',
        reviewOutcome: null,
        raw: 'STATE: BLOCKED\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: none\nBLOCKER: missing dependency\nNEXT_ACTION: install dependency',
      },
    })

    const after = missions.getSwarmMission(mission.id)!
    expect(after.state).toBe('blocked')
    expect(after.assignments[0]!.state).toBe('blocked')

    const reports = missions.listSwarmReports({ missionId: mission.id })
    expect(reports.length).toBeGreaterThan(0)
    expect(reports[0]!.stateLabel).toBe('BLOCKED')

    const cached = JSON.parse(
      readFileSync(missions.SWARM_MISSIONS_PATH, 'utf8'),
    ) as { missions: Array<{ state: string }> }
    expect(cached.missions[0]!.state).toBe('blocked')
  })
})
