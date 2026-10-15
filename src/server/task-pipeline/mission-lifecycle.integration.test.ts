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
  tempRoot = mkdtempSync(join(tmpdir(), 'mission-lifecycle-test-'))
  mkdirSync(join(tempRoot, '.runtime'), { recursive: true })
  vi.doMock('../swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))
  return import('../swarm-missions')
}

describe('mission lifecycle integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../swarm-environment')
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('creates, dispatches, checkpoints, and completes a mission through the repository facade', async () => {
    const missions = await loadMissions()

    const created = missions.createOrUpdateMission({
      missionId: 'lifecycle-1',
      title: 'End-to-end mission',
      spec: 'Build a thing',
      acceptanceCriteria: ['it works'],
      assignments: [
        {
          workerId: 'developer',
          task: 'Implement feature',
          reviewRequired: true,
        },
      ],
    })
    expect(created._created).toBe(true)
    expect(created.state).toBe('ready')

    const developerAssignment = created.assignments[0]!
    expect(developerAssignment.state).toBe('queued')

    const dispatched = missions.markMissionAssignmentDispatched({
      missionId: created.id,
      workerId: 'developer',
      task: 'Implement feature',
      source: 'integration-test',
    })
    expect(dispatched).not.toBeNull()
    expect(dispatched!.assignments[0]!.state).toBe('dispatched')

    const checkpointed = missions.recordMissionCheckpoint({
      missionId: created.id,
      workerId: 'developer',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'src/feature.ts',
        commandsRun: 'npm test',
        result: 'all green',
        blocker: null,
        nextAction: 'review',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: src/feature.ts\nCOMMANDS_RUN: npm test\nRESULT: all green\nBLOCKER: none\nNEXT_ACTION: review',
      },
    })
    expect(checkpointed).not.toBeNull()
    expect(checkpointed!.assignments[0]!.state).toBe('checkpointed')

    const reviewed = missions.markMissionAssignmentReviewed({
      missionId: created.id,
      assignmentId: developerAssignment.id,
      reviewerId: 'architect',
    })
    expect(reviewed).not.toBeNull()
    expect(reviewed!.assignments[0]!.state).toBe('done')
    expect(reviewed!.state).toBe('done')

    // JSON export cache should mirror the final state.
    const cachePath = missions.SWARM_MISSIONS_PATH
    expect(existsSync(cachePath)).toBe(true)
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      version: number
      missions: Array<{
        id: string
        state: string
        assignments: Array<{ state: string }>
      }>
    }
    expect(cached.version).toBe(1)
    const cachedMission = cached.missions.find((m) => m.id === created.id)
    expect(cachedMission).toBeDefined()
    expect(cachedMission!.state).toBe('done')
    expect(cachedMission!.assignments[0]!.state).toBe('done')
  })

  it('cancels a mission and persists the cancelled state to cache', async () => {
    const missions = await loadMissions()

    const created = missions.createOrUpdateMission({
      missionId: 'lifecycle-cancel',
      title: 'Cancelled mission',
      assignments: [
        {
          workerId: 'developer',
          task: 'Do work',
        },
      ],
    })

    missions.cancelSwarmMission({
      missionId: created.id,
      actor: 'integration-test',
      reason: 'no longer needed',
    })

    const after = missions.getSwarmMission(created.id)
    expect(after?.state).toBe('cancelled')
    expect(after?.assignments.every((a) => a.state === 'cancelled')).toBe(true)

    const cached = JSON.parse(
      readFileSync(missions.SWARM_MISSIONS_PATH, 'utf8'),
    ) as { missions: Array<{ state: string }> }
    expect(cached.missions[0]!.state).toBe('cancelled')
  })
})
