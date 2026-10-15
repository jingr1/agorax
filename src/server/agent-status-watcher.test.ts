import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAgentStatusSnapshot,
  listWatchedAgents,
  publishAgentStatus,
  startAgentStatusWatcher,
  stopAgentStatusWatcher,
} from './agent-status-watcher'
import { subscribeToChatEvents } from './chat-event-bus'
import {
  AgentRuntimeRouter,
  setAgentRuntimeRouterForTests,
} from './agent-runtime/router'
import * as claudePaths from './hermes-paths'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    watch: vi.fn(),
  }
})

function makeAgentYaml(): string {
  return `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: dev
    execution: local
    capabilities: [git-ops]
  - id: claude-dev
    runtime: claude-code
    command: claude
    execution: local
    capabilities: [coding]
`
}

describe('agent-status-watcher', () => {
  let tempDir: string
  let watchTriggers = new Map<
    string,
    (event: string, filename: string | null) => void
  >()

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watcher-'))
    setAgentRuntimeRouterForTests(
      new AgentRuntimeRouter({ rawYaml: makeAgentYaml() }),
    )
    vi.spyOn(claudePaths, 'getProfilesDir').mockReturnValue(tempDir)
    watchTriggers = new Map()
    vi.mocked(fs.watch).mockImplementation(
      (filepath: fs.PathLike, ...args: Array<unknown>) => {
        const listener =
          typeof args[args.length - 1] === 'function'
            ? (args[args.length - 1] as (
                event: string,
                filename: string | null,
              ) => void)
            : undefined
        const key =
          typeof filepath === 'string' ? filepath : filepath.toString()
        const trigger = (event: string, filename: string | null) => {
          listener?.(event, filename)
        }
        watchTriggers.set(key, trigger)
        return {
          close: vi.fn(),
          on: vi.fn(),
          [Symbol.asyncIterator]: async function* () {},
        } as unknown as fs.FSWatcher
      },
    )
  })

  afterEach(() => {
    stopAgentStatusWatcher()
    setAgentRuntimeRouterForTests(null)
    vi.restoreAllMocks()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function writeRuntime(agentId: string, data: Record<string, unknown>) {
    const profileDir = path.join(tempDir, agentId)
    if (!fs.existsSync(profileDir))
      fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(
      path.join(profileDir, 'runtime.json'),
      JSON.stringify(data, null, 2),
      'utf8',
    )
  }

  it('watches only declared hermes agents', () => {
    writeRuntime('dev', { state: 'idle' })
    startAgentStatusWatcher()
    expect(listWatchedAgents()).toEqual(['dev'])
  })

  it('publishes agent_status with scope=global on file change', async () => {
    writeRuntime('dev', {
      state: 'executing',
      currentTask: 'build feature',
      missionId: 'm-1',
      checkpointStatus: 'in_progress',
      needsHuman: false,
      lastOutputAt: 1_700_000_000_000,
    })

    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents((evt) => received.push(evt), {
      scope: 'global',
    })

    startAgentStatusWatcher()
    expect(listWatchedAgents()).toEqual(['dev'])

    const runtimePath = path.join(tempDir, 'dev', 'runtime.json')
    const trigger = watchTriggers.get(runtimePath)
    expect(trigger).toBeDefined()

    vi.useFakeTimers({ shouldAdvanceTime: true })
    console.log('trigger', trigger)
    trigger!('change', 'runtime.json')
    await vi.advanceTimersByTimeAsync(350)
    console.log('received after advance', received)
    vi.useRealTimers()

    unsubscribe()

    const statusEvent = received.find((e) => e.event === 'agent_status')
    expect(statusEvent).toBeDefined()
    expect(statusEvent?.data.agentId).toBe('dev')
    expect(statusEvent?.data.scope).toBe('global')
    expect(statusEvent?.data.state).toBe('executing')
    expect(statusEvent?.data.currentTask).toBe('build feature')
  })

  it('returns a snapshot from getAgentStatusSnapshot', () => {
    writeRuntime('dev', {
      state: 'blocked',
      currentTask: 'fix tests',
      needsHuman: true,
      checkpointStatus: 'blocked',
      lastSummary: 'waiting for approval',
    })
    const snap = getAgentStatusSnapshot('dev')
    expect(snap).not.toBeNull()
    expect(snap?.agentId).toBe('dev')
    expect(snap?.state).toBe('blocked')
    expect(snap?.needsHuman).toBe(true)
    expect(snap?.checkpointStatus).toBe('blocked')
    expect(snap?.lastSummary).toBe('waiting for approval')
  })

  it('publishAgentStatus emits a global event', () => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = []
    const unsubscribe = subscribeToChatEvents((evt) => received.push(evt), {
      scope: 'global',
    })
    publishAgentStatus({
      agentId: 'dev',
      runtime: 'hermes',
      state: 'idle',
      currentTask: null,
      taskId: null,
      missionId: null,
      needsHuman: false,
      checkpointStatus: 'none',
      lastSummary: null,
      updatedAt: Date.now(),
    })
    unsubscribe()
    expect(received).toHaveLength(1)
    expect(received[0]?.event).toBe('agent_status')
    expect(received[0]?.data.agentId).toBe('dev')
  })
})
