import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempRoot: string

async function loadModule() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'swarm-missions-test-'))
  vi.doMock('./swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))
  return await import('./swarm-missions')
}

describe('swarm-missions', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'swarm-missions-test-'))
  })

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('./swarm-environment')
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('records checkpoints by assignment id, stores report metadata, and exposes flattened reports', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-report-1',
      title: 'Mission report test',
      assignments: [
        {
          workerId: 'swarm2',
          task: 'Land backend patch',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0]?.id
    expect(assignmentId).toBeTruthy()

    const updated = mod.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId,
      workerId: 'swarm2',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'src/server/swarm-missions.ts',
        commandsRun: 'pnpm vitest src/server/swarm-missions.test.ts',
        result: 'Recorded canonical checkpoint',
        blocker: null,
        nextAction: 'handoff to reviewer',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: src/server/swarm-missions.ts\nCOMMANDS_RUN: pnpm vitest src/server/swarm-missions.test.ts\nRESULT: Recorded canonical checkpoint\nBLOCKER: none\nNEXT_ACTION: handoff to reviewer',
      },
      source: 'swarm-orchestrator-loop',
    })

    expect(updated).not.toBeNull()
    expect(updated?.state).toBe('done')
    expect(updated?.assignments[0]?.state).toBe('checkpointed')
    expect(updated?._completed).toBe(true)

    const checkpointEvent = updated?.events.find(
      (event) => event.type === 'checkpoint',
    )
    expect(checkpointEvent?.data?.source).toBe('swarm-orchestrator-loop')
    expect(checkpointEvent?.data?.result).toBe('Recorded canonical checkpoint')
    expect(checkpointEvent?.data?.commandsRun).toBe(
      'pnpm vitest src/server/swarm-missions.test.ts',
    )

    const reports = mod.listSwarmReports({ missionId: mission.id })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      missionId: mission.id,
      assignmentId,
      workerId: 'swarm2',
      stateLabel: 'DONE',
      source: 'swarm-orchestrator-loop',
      result: 'Recorded canonical checkpoint',
    })
  })

  it('deduplicates identical checkpoint raws for the same assignment', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-report-2',
      title: 'Dedup test',
      assignments: [
        {
          workerId: 'swarm2',
          task: 'Land backend patch',
          reviewRequired: false,
        },
      ],
    })
    const assignmentId = mission.assignments[0]?.id
    const checkpoint = {
      stateLabel: 'DONE' as const,
      runtimeState: 'idle' as const,
      checkpointStatus: 'done' as const,
      filesChanged: 'none',
      commandsRun: 'none',
      result: 'Same checkpoint',
      blocker: null,
      nextAction: 'none',
      reviewOutcome: null,
      raw: 'STATE: DONE\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: Same checkpoint\nBLOCKER: none\nNEXT_ACTION: none',
    }

    const first = mod.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId,
      workerId: 'swarm2',
      checkpoint,
      source: 'swarm-checkpoint-api',
    })
    const second = mod.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId,
      workerId: 'swarm2',
      checkpoint,
      source: 'swarm-checkpoint-api',
    })

    expect(
      first?.events.filter((event) => event.type === 'checkpoint'),
    ).toHaveLength(1)
    expect(
      second?.events.filter((event) => event.type === 'checkpoint'),
    ).toHaveLength(1)
    expect(mod.listSwarmReports({ missionId: mission.id })).toHaveLength(1)
    expect(existsSync(mod.SWARM_MISSIONS_PATH)).toBe(true)
  })

  it('does not infer review-required from dispatch/checkpoint wording alone', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-dispatch-smoke-review',
      title: 'Diagnostic dispatch smoke',
      assignments: [
        {
          workerId: 'builder',
          task: 'Diagnostic smoke only. Return RESULT: workspace swarm dispatch API smoke passed.',
          rationale: 'diagnostic dispatch smoke',
        },
      ],
    })

    expect(mission.assignments[0]?.reviewRequired).toBe(false)

    const updated = mod.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId: mission.assignments[0]?.id,
      workerId: 'builder',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'none',
        commandsRun: 'none',
        result: 'workspace swarm dispatch API smoke passed',
        blocker: null,
        nextAction: 'none',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: workspace swarm dispatch API smoke passed\nBLOCKER: none\nNEXT_ACTION: none',
      },
      source: 'swarm-dispatch',
    })

    expect(updated?.state).toBe('done')
  })

  it('records dispatch failures as blocked mission assignments', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-dispatch-failure',
      title: 'Dispatch failure test',
      assignments: [
        {
          workerId: 'builder',
          task: 'Probe runtime health',
          reviewRequired: false,
        },
      ],
    })
    mod.markMissionAssignmentDispatched({
      missionId: mission.id,
      workerId: 'builder',
      task: 'Probe runtime health',
    })

    const blocked = mod.recordMissionAssignmentBlocked({
      missionId: mission.id,
      assignmentId: mission.assignments[0]?.id,
      workerId: 'builder',
      reason: 'No fresh checkpoint before poll timeout.',
      source: 'swarm-dispatch',
    })

    expect(blocked?.mission.state).toBe('blocked')
    expect(blocked?.assignment.state).toBe('blocked')
    expect(blocked?.assignment.checkpoint).toMatchObject({
      stateLabel: 'BLOCKED',
      checkpointStatus: 'blocked',
      blocker: 'No fresh checkpoint before poll timeout.',
    })
    expect(blocked?.mission.events.at(-1)?.type).toBe('blocked')
  })

  it('keeps dependent work queued until review-required assignments are reviewed', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-review-gate',
      title: 'Review gate test',
      assignments: [
        {
          workerId: 'swarm2',
          task: 'Implement orchestration patch',
          reviewRequired: true,
        },
        {
          workerId: 'swarm8',
          task: 'Ship final action',
          dependsOn: [],
          reviewRequired: false,
        },
      ],
    })
    const implementation = mission.assignments[0]
    const finalAction = mission.assignments[1]
    finalAction.dependsOn = [implementation.id]

    const checkpoint = {
      stateLabel: 'DONE' as const,
      runtimeState: 'idle' as const,
      checkpointStatus: 'done' as const,
      filesChanged: 'src/routes/api/swarm-orchestrator-loop.ts',
      commandsRun: 'pnpm vitest run src/server/swarm-missions.test.ts',
      result: 'Implementation complete',
      blocker: null,
      nextAction: 'Request QA review',
      reviewOutcome: null,
      raw: 'STATE: DONE\nFILES_CHANGED: src/routes/api/swarm-orchestrator-loop.ts\nCOMMANDS_RUN: pnpm vitest run src/server/swarm-missions.test.ts\nRESULT: Implementation complete\nBLOCKER: none\nNEXT_ACTION: Request QA review',
    }

    const checkpointed = mod.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId: implementation.id,
      workerId: 'swarm2',
      checkpoint,
      source: 'swarm-checkpoint-api',
    })

    expect(checkpointed?.state).toBe('review')
    expect(checkpointed?.assignments[0]?.state).toBe('checkpointed')
    expect(checkpointed?.assignments[1]?.state).toBe('queued')

    const reviewed = mod.markMissionAssignmentsReviewedByWorker({
      missionId: mission.id,
      reviewerId: 'swarm11',
    })

    expect(reviewed?.reviewedAssignmentIds).toEqual([implementation.id])
    expect(reviewed?.mission.assignments[0]).toMatchObject({
      state: 'done',
      reviewedBy: 'swarm11',
    })
    expect(
      mod.readyQueuedAssignments(mission.id).map((assignment) => assignment.id),
    ).toEqual([finalAction.id])
  })

  it('cancels active missions without accepting stale checkpoints afterward', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-cancel-1',
      title: 'Cancel test',
      assignments: [
        {
          workerId: 'swarm2',
          task: 'Active backend task',
          reviewRequired: false,
        },
        {
          workerId: 'swarm5',
          task: 'Queued builder task',
          reviewRequired: false,
        },
      ],
    })
    mod.markMissionAssignmentDispatched({
      missionId: mission.id,
      workerId: 'swarm2',
      task: 'Active backend task',
    })

    const cancelled = mod.cancelSwarmMission({
      missionId: mission.id,
      actor: 'test',
      reason: 'User cancelled bad swarm run',
    })

    expect(cancelled?.mission.state).toBe('cancelled')
    expect(cancelled?.cancelledAssignmentIds).toHaveLength(2)
    expect(
      cancelled?.mission.assignments.map((assignment) => assignment.state),
    ).toEqual(['cancelled', 'cancelled'])
    expect(cancelled?.mission.events.at(-1)?.type).toBe('mission_cancelled')

    const staleCheckpoint = mod.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId: mission.assignments[0]?.id,
      workerId: 'swarm2',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'none',
        commandsRun: 'none',
        result: 'Stale checkpoint after cancel',
        blocker: null,
        nextAction: 'none',
        reviewOutcome: null,
        raw: 'STATE: DONE\nRESULT: stale',
      },
      source: 'stale-worker',
    })

    expect(staleCheckpoint?._ignoredReason).toContain('cancelled')
    const persisted = mod.getSwarmMission(mission.id)
    expect(persisted?.state).toBe('cancelled')
    expect(persisted?.assignments[0]?.state).toBe('cancelled')
    expect(
      persisted?.events.filter((event) => event.type === 'checkpoint'),
    ).toHaveLength(0)
  })

  it('cancels a single assignment and leaves unaffected work active', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-cancel-assignment',
      title: 'Assignment cancel test',
      assignments: [
        { workerId: 'swarm2', task: 'Cancel this', reviewRequired: false },
        { workerId: 'swarm5', task: 'Keep this queued', reviewRequired: false },
      ],
    })

    const cancelled = mod.cancelSwarmAssignment({
      missionId: mission.id,
      assignmentId: mission.assignments[0]?.id,
      actor: 'test',
      reason: 'Only one bad lane',
    })

    expect(cancelled?.assignment.state).toBe('cancelled')
    // Remaining queued assignment → Multica `ready` (dispatchable work).
    expect(cancelled?.mission.state).toBe('ready')
    expect(
      cancelled?.mission.assignments.map((assignment) => assignment.state),
    ).toEqual(['cancelled', 'queued'])
    expect(cancelled?.mission.events.at(-1)?.type).toBe('assignment_cancelled')
  })

  it('archives stale executing missions when all assignments are terminal', async () => {
    const mod = await loadModule()
    const staleMission = {
      version: 1,
      missions: [
        {
          id: 'mission-stale-terminal',
          title: 'Stale executing mission',
          state: 'running',
          createdAt: 1,
          updatedAt: 1,
          assignments: [
            {
              id: 'assign-1',
              workerId: 'swarm2',
              task: 'Done work',
              rationale: null,
              dependsOn: [],
              reviewRequired: false,
              state: 'done',
              dispatchedAt: 1,
              completedAt: 1,
              reviewedAt: 1,
              reviewedBy: 'swarm6',
              checkpoint: null,
            },
            {
              id: 'assign-2',
              workerId: 'swarm3',
              task: 'Blocked work',
              rationale: null,
              dependsOn: [],
              reviewRequired: false,
              state: 'blocked',
              dispatchedAt: 1,
              completedAt: 1,
              reviewedAt: null,
              reviewedBy: null,
              checkpoint: null,
            },
          ],
          events: [],
        },
      ],
    }

    mkdirSync(join(tempRoot, '.runtime'), { recursive: true })
    writeFileSync(
      mod.SWARM_MISSIONS_PATH,
      JSON.stringify(staleMission, null, 2),
    )

    expect(mod.archiveStaleMissions()).toEqual({
      archivedIds: ['mission-stale-terminal'],
      count: 1,
    })

    const persisted = JSON.parse(readFileSync(mod.SWARM_MISSIONS_PATH, 'utf8'))
    expect(persisted.missions[0]?.state).toBe('done')
    expect(persisted.missions[0]?.events.at(-1)?.message).toContain(
      'Archived as stale',
    )
  })

  it('leaves recent executing missions alone', async () => {
    const mod = await loadModule()
    const recentUpdatedAt = Date.now() - 60 * 60 * 1000
    const recentMission = {
      version: 1,
      missions: [
        {
          id: 'mission-recent-terminal',
          title: 'Recent executing mission',
          state: 'running',
          createdAt: recentUpdatedAt,
          updatedAt: recentUpdatedAt,
          assignments: [
            {
              id: 'assign-1',
              workerId: 'swarm2',
              task: 'Done work',
              rationale: null,
              dependsOn: [],
              reviewRequired: false,
              state: 'done',
              dispatchedAt: recentUpdatedAt,
              completedAt: recentUpdatedAt,
              reviewedAt: recentUpdatedAt,
              reviewedBy: 'swarm6',
              checkpoint: null,
            },
          ],
          events: [],
        },
      ],
    }

    mkdirSync(join(tempRoot, '.runtime'), { recursive: true })
    writeFileSync(
      mod.SWARM_MISSIONS_PATH,
      JSON.stringify(recentMission, null, 2),
    )

    expect(mod.archiveStaleMissions()).toEqual({
      archivedIds: [],
      count: 0,
    })

    const persisted = JSON.parse(readFileSync(mod.SWARM_MISSIONS_PATH, 'utf8'))
    expect(persisted.missions[0]?.state).toBe('running')
    expect(persisted.missions[0]?.events).toHaveLength(0)
  })

  it('rejects a cyclic dependsOn graph at registration (pipeline would silently die)', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-cycle',
      title: 'cycle test',
      assignments: [{ workerId: 'w1', task: 'A', reviewRequired: false }],
    })
    const aId = mission.assignments[0].id
    // B depends on A — fine.
    mod.appendMissionContinuation({
      missionId: mission.id,
      workerId: 'w2',
      task: 'B',
      rationale: 'r',
      dependsOn: [aId],
    })
    // Now close a cycle: C depends on B... and then make A depend on C by
    // directly exercising the guard with a synthetic graph (registration API
    // only adds forward edges, so the unit-level guard is what must hold).
    const bId = mod
      .getSwarmMission(mission.id)!
      .assignments.find((a) => a.workerId === 'w2')!.id
    expect(() =>
      mod.assertAcyclicDependencies([
        { id: 'a', dependsOn: ['c'] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['b'] },
      ] as never),
    ).toThrow(/cycle detected/)
    // The real chain stays acyclic and dispatchable.
    expect(mod.readyQueuedAssignments(mission.id).map((a) => a.id)).toEqual([
      aId,
    ])
    expect(bId).toBeTruthy()
  })

  it('assertAcyclicDependencies accepts DAGs and ignores unknown ids', async () => {
    const mod = await loadModule()
    expect(() =>
      mod.assertAcyclicDependencies([
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['a', 'b'] },
      ] as never),
    ).not.toThrow()
    // Unknown dependency ids are not cycles (they just never satisfy).
    expect(() =>
      mod.assertAcyclicDependencies([
        { id: 'a', dependsOn: ['ghost'] },
      ] as never),
    ).not.toThrow()
    // Self-loop is a cycle.
    expect(() =>
      mod.assertAcyclicDependencies([{ id: 'a', dependsOn: ['a'] }] as never),
    ).toThrow(/cycle detected/)
  })

  it('persists and patches mission spec / acceptanceCriteria with specVersion bump', async () => {
    const mod = await loadModule()
    const mission = mod.createOrUpdateMission({
      missionId: 'mission-spec-1',
      title: 'Spec persist',
      spec: 'See `src/app.ts`',
      acceptanceCriteria: ['tests pass'],
      assignments: [],
    })
    expect(mission.spec).toBe('See `src/app.ts`')
    expect(mission.acceptanceCriteria).toEqual(['tests pass'])
    expect(mission.specVersion).toBe(1)

    const patched = mod.patchMissionFields({
      missionId: mission.id,
      spec: 'See `src/app.ts` and `README.md`',
      acceptanceCriteria: ['tests pass', 'docs updated'],
    })
    expect(patched?.spec).toContain('README.md')
    expect(patched?.acceptanceCriteria).toEqual([
      'tests pass',
      'docs updated',
    ])
    expect(patched?.specVersion).toBe(2)

    const noop = mod.patchMissionFields({
      missionId: mission.id,
      spec: patched!.spec,
      acceptanceCriteria: patched!.acceptanceCriteria,
    })
    expect(noop?.specVersion).toBe(2)
  })
})
