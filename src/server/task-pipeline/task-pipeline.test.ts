import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Module imports in this file are heavy (task-service pulls in the runtime
// subtree); the default 5s timeout is too tight on first load.
vi.setConfig({ testTimeout: 30_000 })

let tempRoot: string
let dbPath: string

async function loadModules() {
  vi.resetModules()
  tempRoot = mkdtempSync(join(tmpdir(), 'task-pipeline-test-'))
  dbPath = join(tempRoot, 'collab.db')
  vi.doMock('../collab-db', async () => {
    const actual = await vi.importActual('../collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/collab-db', async () => {
    const actual = await vi.importActual('../../server/collab-db')
    return { ...actual, getCollabDbPath: () => dbPath }
  })
  vi.doMock('../../server/swarm-environment', () => ({
    SWARM_CANONICAL_REPO: tempRoot,
    SWARM_MISSIONS_PATH: join(tempRoot, '.runtime', 'swarm-missions.json'),
    SWARM_MEMORY_HANDOFFS: join(tempRoot, 'memory'),
    SWARM_LEGACY_OUTPUT_ROOT: join(tempRoot, 'output'),
  }))
  vi.doMock('../../routes/api/swarm-dispatch', () => ({
    dispatchSwarmAssignments: vi.fn().mockResolvedValue({ results: [] }),
  }))
  vi.doMock('../../server/agent-runtime/agents-config', () => ({
    loadAgentsRegistry: () => ({
      version: 1,
      agents: [
        ...AGENTS.map(makeMockAgent),
        {
          id: 'gpuserver',
          runtime: 'hermes',
          execution: 'ssh',
          profile: 'gpuserver',
          capabilities: ['gpu'],
        },
        {
          id: 'cc-impl',
          runtime: 'claude-code',
          execution: 'local',
          command: 'claude',
          capabilities: [],
        },
      ],
      byId: new Map([
        ...AGENTS.map((id) => [id, makeMockAgent(id)] as const),
        [
          'gpuserver',
          {
            id: 'gpuserver',
            runtime: 'hermes',
            execution: 'ssh',
            profile: 'gpuserver',
            capabilities: ['gpu'],
          },
        ],
        [
          'cc-impl',
          {
            id: 'cc-impl',
            runtime: 'claude-code',
            execution: 'local',
            command: 'claude',
            capabilities: [],
          },
        ],
      ]),
      orphanProfiles: [],
    }),
    detectExecutionFromProfile: () => 'local',
    getProfileSshHost: () => null,
  }))
  const templates =
    await import('../../server/task-pipeline/pipeline-templates')
  const taskService = await import('../../server/task-pipeline/task-service')
  const review = await import('../../server/task-pipeline/review')
  const laneSync = await import('../../server/task-pipeline/lane-sync')
  const stageBrief = await import('../../server/task-pipeline/stage-brief')
  const missions = await import('../../server/swarm-missions')
  return { templates, taskService, review, laneSync, stageBrief, missions }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../collab-db')
  vi.doUnmock('../../server/collab-db')
  vi.doUnmock('../../server/swarm-environment')
  vi.doUnmock('../../server/agent-runtime/agents-config')
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const AGENTS = [
  'researcher',
  'architect',
  'developer',
  'learning',
  'writer',
  'orchestrator',
]

function makeMockAgent(id: string) {
  return {
    id,
    runtime: id === 'orchestrator' ? ('hermes' as const) : ('claude-code' as const),
    execution: 'local' as const,
    profile: id,
    capabilities: [],
  }
}

const VALID_PIPELINE = `
version: 1
pipelines:
  - id: default-build
    name: build
    workspaceMode: canonical
    stages:
      - key: research
        agent: researcher
        dependsOn: []
      - key: spec
        agent: architect
        dependsOn: [research]
      - key: build
        agent: developer
        dependsOn: [spec]
      - key: review
        agent: architect
        kind: review
        reworkTarget: build
        dependsOn: [build]
      - key: retro
        agent: learning
        dependsOn: [review]
`

describe('pipeline-templates', () => {
  it('loads a valid canonical pipeline', async () => {
    const { templates } = await loadModules()
    const file = templates.loadPipelineTemplates({
      rawYaml: VALID_PIPELINE,
      agentIds: new Set(AGENTS),
    })
    expect(file.pipelines).toHaveLength(1)
    expect(file.pipelines[0].stages.map((s) => s.key)).toEqual([
      'research',
      'spec',
      'build',
      'review',
      'retro',
    ])
    expect(file.pipelines[0].workspaceMode).toBe('canonical')
  })

  it('rejects local hermes worker in worktree mode', async () => {
    const { templates } = await loadModules()
    const rawYaml = `
version: 1
pipelines:
  - id: worktree-local
    name: worktree-local
    workspaceMode: worktree
    stages:
      - key: only
        agent: orchestrator
        dependsOn: []
`
    expect(() =>
      templates.loadPipelineTemplates({
        repoRoot: '/tmp',
        rawYaml,
        agentIds: new Set(['orchestrator']),
      }),
    ).toThrow(/workspaceMode=worktree forbids local hermes tmux worker/)
  })

  it('allows managed CLI adapter in worktree mode', async () => {
    const { templates } = await loadModules()
    const rawYaml = VALID_PIPELINE.replace(
      'workspaceMode: canonical',
      'workspaceMode: worktree',
    )
    expect(() =>
      templates.loadPipelineTemplates({
        repoRoot: '/tmp',
        rawYaml,
        agentIds: new Set(['researcher', 'architect', 'developer', 'learning']),
      }),
    ).not.toThrow()
  })

  it('rejects cyclic stage graph', async () => {
    const { templates } = await loadModules()
    expect(() =>
      templates.loadPipelineTemplates({
        rawYaml: `
version: 1
pipelines:
  - id: cyc
    workspaceMode: canonical
    stages:
      - key: a
        agent: researcher
        dependsOn: [b]
      - key: b
        agent: architect
        dependsOn: [a]
`,
        agentIds: new Set(AGENTS),
      }),
    ).toThrow(/cycle/)
  })

  it('rejects unknown dependsOn / reworkTarget / agent', async () => {
    const { templates } = await loadModules()
    expect(() =>
      templates.loadPipelineTemplates({
        rawYaml: VALID_PIPELINE.replace(
          'dependsOn: [research]',
          'dependsOn: [ghost]',
        ).replace('reworkTarget: build', 'reworkTarget: ghost'),
        agentIds: new Set(AGENTS),
      }),
    ).toThrow(/unknown dependsOn|unknown reworkTarget/)
    expect(() =>
      templates.loadPipelineTemplates({
        rawYaml: VALID_PIPELINE.replace('agent: researcher', 'agent: nobody'),
        agentIds: new Set(AGENTS),
      }),
    ).toThrow(/not declared in agents.yaml/)
  })
})

describe('stage-brief staleness', () => {
  it('isBriefStale compares versions', async () => {
    const { stageBrief } = await loadModules()
    expect(stageBrief.isBriefStale(1, 1)).toBe(false)
    expect(stageBrief.isBriefStale(1, 2)).toBe(true)
  })
})

describe('review.ts', () => {
  it('parseReviewOutcome extracts verdict + feedback', async () => {
    const { review } = await loadModules()
    expect(review.parseReviewOutcome('REVIEW_OUTCOME: approved')).toEqual({
      outcome: 'approved',
      feedback: null,
    })
    const cr = review.parseReviewOutcome(
      'REVIEW_OUTCOME: changes_requested\nfile x.ts line 3 is wrong',
    )
    expect(cr?.outcome).toBe('changes_requested')
    expect(cr?.feedback).toContain('x.ts')
    expect(review.parseReviewOutcome('no verdict here')).toBeNull()
  })

  it('reworks up to maxRework=2 then escalates to human', async () => {
    const { templates, taskService, missions, review } = await loadModules()
    const template = templates.loadPipelineTemplates({
      rawYaml: VALID_PIPELINE,
      agentIds: new Set(AGENTS),
    }).pipelines[0]

    expect(template.stages.find((s) => s.key === 'review')?.maxRework).toBe(2)

    const mission = taskService.instantiatePipeline({
      template,
      title: 'Build',
      spec: 'spec',
      acceptanceCriteria: ['works'],
      // card removed
    })

    const buildAssignment = mission.assignments.find(
      (a) => a.stageKey === 'build',
    )!
    const reviewAssignment = mission.assignments.find(
      (a) => a.stageKey === 'review',
    )!

    function recordDone(assignmentId: string, workerId: string) {
      missions.recordMissionCheckpoint({
        missionId: mission.id,
        assignmentId,
        workerId,
        checkpoint: {
          stateLabel: 'DONE',
          runtimeState: 'idle',
          checkpointStatus: 'done',
          filesChanged: 'none',
          commandsRun: 'none',
          result: 'done',
          blocker: 'none',
          nextAction: 'none',
          reviewOutcome: null,
          raw: 'STATE: DONE\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: done\nBLOCKER: none\nNEXT_ACTION: none',
        },
      })
    }

    function requestChanges(attempt: number) {
      const raw =
        `STATE: DONE\n` +
        `FILES_CHANGED: none\n` +
        `COMMANDS_RUN: none\n` +
        `RESULT: review\n` +
        `BLOCKER: none\n` +
        `NEXT_ACTION: rework\n` +
        `REVIEW_OUTCOME: changes_requested\n` +
        `fix attempt ${attempt}`
      missions.recordMissionCheckpoint({
        missionId: mission.id,
        assignmentId: reviewAssignment.id,
        workerId: 'architect',
        source: 'mcp',
        checkpoint: {
          stateLabel: 'DONE',
          runtimeState: 'idle',
          checkpointStatus: 'done',
          filesChanged: 'none',
          commandsRun: 'none',
          result: 'review',
          blocker: 'none',
          nextAction: 'rework',
          reviewOutcome: 'changes_requested',
          raw,
        },
      })
      return review.applyReviewVerdict({
        missionId: mission.id,
        reviewAssignmentId: reviewAssignment.id,
        rawCheckpoint: raw,
        reviewerId: 'architect',
        template,
      })
    }

    const retroAssignment = mission.assignments.find(
      (a) => a.stageKey === 'retro',
    )!

    // First cycle: build done → review changes → rework #1
    recordDone(buildAssignment.id, 'developer')
    const r1 = requestChanges(1)
    expect(r1.ok && r1.action === 'rework').toBe(true)
    if (r1.ok && r1.action === 'rework') expect(r1.attempt).toBe(1)

    // After changes_requested both build and review should be requeued,
    // and downstream retro must NOT be ready yet.
    const afterR1 = missions.getSwarmMission(mission.id)!
    expect(
      afterR1.assignments.find((a) => a.id === buildAssignment.id)!.state,
    ).toBe('queued')
    expect(
      afterR1.assignments.find((a) => a.id === reviewAssignment.id)!.state,
    ).toBe('queued')
    expect(
      missions
        .readyQueuedAssignments(mission.id)
        .some((a) => a.id === retroAssignment.id),
    ).toBe(false)

    // Second cycle: rebuild → review changes → rework #2
    recordDone(buildAssignment.id, 'developer')
    const r2 = requestChanges(2)
    expect(r2.ok && r2.action === 'rework').toBe(true)
    if (r2.ok && r2.action === 'rework') expect(r2.attempt).toBe(2)

    // Third cycle: maxRework reached → needs human
    recordDone(buildAssignment.id, 'developer')
    const r3 = requestChanges(3)
    expect(r3.ok && r3.action === 'needs_human').toBe(true)
  })

  it('swarm checkpoint hook triggers rework for non-mcp sources', async () => {
    const { templates, taskService, missions, review } = await loadModules()
    // Write a pipelines.yaml so the swarm-path hook can resolve the template.
    // Importing `review` registers the checkpoint hook we're testing.
    expect(typeof review.applyReviewVerdict).toBe('function')
    // Disable the terminal continuation hook so it doesn't race with the review
    // verdict and re-dispatch the review stage while we're asserting requeue.
    missions.setOnCheckpointTerminalHook(null)
    writeFileSync(join(tempRoot, 'pipelines.yaml'), VALID_PIPELINE)

    const template = templates.loadPipelineTemplates({
      repoRoot: tempRoot,
      agentIds: new Set(AGENTS),
    }).pipelines[0]

    const mission = taskService.instantiatePipeline({
      template,
      title: 'Build',
      spec: 'spec',
      acceptanceCriteria: ['works'],
      // card removed
    })

    const buildAssignment = mission.assignments.find(
      (a) => a.stageKey === 'build',
    )!
    const reviewAssignment = mission.assignments.find(
      (a) => a.stageKey === 'review',
    )!

    // Build completes.
    missions.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId: buildAssignment.id,
      workerId: 'developer',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'none',
        commandsRun: 'none',
        result: 'build done',
        blocker: 'none',
        nextAction: 'review',
        reviewOutcome: null,
        raw: 'STATE: DONE\nFILES_CHANGED: none\nCOMMANDS_RUN: none\nRESULT: build done\nBLOCKER: none\nNEXT_ACTION: review',
      },
    })

    // Review returns changes_requested via swarm checkpoint (source !== 'mcp').
    const raw =
      `STATE: DONE\n` +
      `FILES_CHANGED: none\n` +
      `COMMANDS_RUN: none\n` +
      `RESULT: review\n` +
      `BLOCKER: none\n` +
      `NEXT_ACTION: rework\n` +
      `REVIEW_OUTCOME: changes_requested\n` +
      `fix it`
    missions.recordMissionCheckpoint({
      missionId: mission.id,
      assignmentId: reviewAssignment.id,
      workerId: 'architect',
      source: 'swarm-dispatch',
      checkpoint: {
        stateLabel: 'DONE',
        runtimeState: 'idle',
        checkpointStatus: 'done',
        filesChanged: 'none',
        commandsRun: 'none',
        result: 'review',
        blocker: 'none',
        nextAction: 'rework',
        reviewOutcome: 'changes_requested',
        raw,
      },
    })

    // Wait for the async review hook to finish.
    await new Promise((r) => setTimeout(r, 100))

    const after = missions.getSwarmMission(mission.id)!
    console.log('after states:', after.assignments.map((a) => ({ stageKey: a.stageKey, state: a.state, workerId: a.workerId })))
    console.log('after events:', after.events.map((e) => ({ type: e.type, message: e.message, data: e.data })))
    expect(after.assignments.find((a) => a.id === buildAssignment.id)!.state).toBe(
      'queued',
    )
    expect(
      after.assignments.find((a) => a.id === reviewAssignment.id)!.state,
    ).toBe('queued')
    expect(
      after.events.some(
        (e) => e.type === 'continuation' && e.message.includes('for rework'),
      ),
    ).toBe(true)
  })
})

describe('task-service instantiatePipeline (two-pass)', () => {
  it('builds a mission with dependsOn wired stage→assignment and a single ready first stage', async () => {
    const { templates, taskService, missions } = await loadModules()
    const template = templates.loadPipelineTemplates({
      rawYaml: VALID_PIPELINE,
      agentIds: new Set(AGENTS),
    }).pipelines[0]

    const mission = taskService.instantiatePipeline({
      template,
      title: 'Build the thing',
      spec: 'spec text here',
      acceptanceCriteria: ['works'],
      // card removed
    })

    // 5 stages → 5 assignments, architect owns spec+review (two assignments).
    expect(mission.assignments).toHaveLength(5)
    expect(mission.pipelineId).toBe('default-build')
    expect(mission.taskId ?? null).toBeNull()
    expect(mission.specVersion).toBe(1)

    const byStage = new Map(mission.assignments.map((a) => [a.stageKey, a]))
    // research has no deps; spec depends on research's assignment id, etc.
    expect(byStage.get('research')!.dependsOn).toEqual([])
    expect(byStage.get('spec')!.dependsOn).toEqual([
      byStage.get('research')!.id,
    ])
    expect(byStage.get('build')!.dependsOn).toEqual([byStage.get('spec')!.id])
    expect(byStage.get('review')!.dependsOn).toEqual([byStage.get('build')!.id])
    expect(byStage.get('retro')!.dependsOn).toEqual([byStage.get('review')!.id])

    // Only research is dispatchable initially.
    const ready = missions.readyQueuedAssignments(mission.id)
    expect(ready.map((a) => a.stageKey)).toEqual(['research'])

    // Brief text carries the spec and stage role.
    expect(byStage.get('build')!.task).toContain('spec text here')
    expect(byStage.get('review')!.task).toContain('REVIEW_OUTCOME')
  })
})

describe('lane-sync', () => {
  it('maps mission state to lane', async () => {
    const { laneSync } = await loadModules()
    const base = {
      id: 'm',
      title: 't',
      state: 'running' as const,
      createdAt: 0,
      updatedAt: 0,
      events: [],
    }
    const mk = (state: string) => ({
      id: state,
      workerId: 'w',
      task: '',
      rationale: null,
      dependsOn: [],
      reviewRequired: false,
      state,
      dispatchedAt: null,
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      checkpoint: null,
    })
    expect(
      laneSync.laneFromMission({
        ...base,
        state: 'done',
        assignments: [],
      } as never),
    ).toBe('todo')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('blocked')],
      } as never),
    ).toBe('blocked')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('dispatched')],
      } as never),
    ).toBe('running')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('reviewing')],
      } as never),
    ).toBe('review')
    expect(
      laneSync.laneFromMission({
        ...base,
        assignments: [mk('queued')],
      } as never),
    ).toBe('ready')
  })
})
