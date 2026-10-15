/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Importing task-service pulls in the runtime subtree; first load can exceed
// the default 5s timeout.
vi.setConfig({ testTimeout: 30_000 })

describe('createMission XOR', () => {
  let prevCwd: string
  let tmp: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmp = mkdtempSync(join(tmpdir(), 'mission-xor-'))
    writeFileSync(
      join(tmp, 'pipelines.yaml'),
      `version: 1
pipelines:
  - id: design-implement
    name: Design Implement
    workspaceMode: canonical
    stages:
      - key: design
        agent: architect
        dependsOn: []
      - key: build
        agent: developer
        dependsOn: [design]
`,
    )
    writeFileSync(
      join(tmp, 'agents.yaml'),
      `version: 2
agents:
  - id: architect
    name: Architect
    role: design
    specialty: design
    mission: design
    profile: architect
    modes: [design]
    tools: [file]
    skills: []
    plugins: []
    pluginToolsets: []
    mcpServers: []
    wrapper: architect:design
    capabilities: [design]
    enabled: true
    runtime: hermes
    execution: local
    dispatchable: true
  - id: developer
    name: Developer
    role: implement
    specialty: implement
    mission: implement
    profile: developer
    modes: [implement]
    tools: [file]
    skills: []
    plugins: []
    pluginToolsets: []
    mcpServers: []
    wrapper: developer:implement
    capabilities: [implement]
    enabled: true
    runtime: hermes
    execution: local
    dispatchable: true
`,
    )
    mkdirSync(join(tmp, '.runtime'), { recursive: true })
    process.chdir(tmp)
    vi.resetModules()
  })

  afterEach(() => {
    process.chdir(prevCwd)
    vi.resetModules()
    vi.doUnmock('../swarm-environment')
    vi.doUnmock('./dispatch-ready')
    vi.doUnmock('../group-chat/room-store')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects pipelineId + assignee together via normalize path', async () => {
    const { createMission } = await import('./task-service')
    await expect(
      createMission({
        title: 'x',
        spec: 'y',
        pipelineId: 'design-implement',
        executionMode: 'assignee',
        assignee: { type: 'agent', id: 'developer' },
      } as never),
    ).rejects.toThrow(/mutually exclusive/)
  })

  it('pipeline create keeps roomId null and decomposes tasks', async () => {
    vi.doMock('../swarm-environment', () => ({
      SWARM_CANONICAL_REPO: tmp,
    SWARM_MISSIONS_PATH: join(tmp, '.runtime', 'swarm-missions.json'),
      SWARM_MEMORY_HANDOFFS: join(tmp, 'memory'),
      SWARM_LEGACY_OUTPUT_ROOT: join(tmp, 'output'),
    }))
    vi.doMock('./dispatch-ready', () => ({
      dispatchReadyAssignments: vi.fn(async () => ({
        ok: true,
        dispatched: [{ assignmentId: 'a1', workerId: 'architect', ok: true }],
      })),
    }))

    const { createMission } = await import('./task-service')
    const { getSwarmMission } = await import('../swarm-missions')

    const created = await createMission({
      title: 'Pipe mission',
      spec: 'Build it',
      executionMode: 'pipeline',
      pipelineId: 'design-implement',
      autoDispatch: true,
    })

    expect(created.roomId).toBeNull()
    expect(created.executionMode).toBe('pipeline')
    expect(created.pipelineId).toBe('design-implement')
    expect(created.missionId).toBeTruthy()
    expect(created.dispatched.length).toBeGreaterThan(0)

    const mission = getSwarmMission(created.missionId)
    expect(mission?.roomId ?? null).toBeNull()
    expect(mission?.spec).toBe('Build it')
    expect(mission?.specVersion).toBe(1)
    expect(mission?.assignments.length).toBe(2)
    expect(mission?.assignments.every((a) => a.dispatchable !== false)).toBe(
      true,
    )
  })

  it('assignee chat_group binds roomId without tasks', async () => {
    vi.doMock('../swarm-environment', () => ({
      SWARM_CANONICAL_REPO: tmp,
    SWARM_MISSIONS_PATH: join(tmp, '.runtime', 'swarm-missions.json'),
      SWARM_MEMORY_HANDOFFS: join(tmp, 'memory'),
      SWARM_LEGACY_OUTPUT_ROOT: join(tmp, 'output'),
    }))
    vi.doMock('./dispatch-ready', () => ({
      dispatchReadyAssignments: vi.fn(async () => ({
        ok: true,
        dispatched: [],
      })),
    }))
    vi.doMock('../group-chat/room-store', () => ({
      getRoom: vi.fn(() => ({ id: 'room-abc', title: 'Collab' })),
    }))

    const { createMission } = await import('./task-service')
    const created = await createMission({
      title: 'Group mission',
      spec: 'Discuss',
      executionMode: 'assignee',
      assignee: { type: 'chat_group', id: 'room-abc' },
    })

    expect(created.roomId).toBe('room-abc')
    expect(created.firstAssignmentIds).toEqual([])
  })
})
