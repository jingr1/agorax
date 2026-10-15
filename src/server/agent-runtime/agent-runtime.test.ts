/** @vitest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAgentsRegistry } from './agents-config'
import {
  isProcessGroupAlive,
  killProcessGroup,
  listPids,
  lookupPid,
  reconcileRegistry,
  registerPid,
  unregisterPid,
} from './pid-registry'
import { AgentRuntimeRouter } from './router'
import { getStateDir } from '../workspace-state-dir'

vi.mock('./hermes-gateway-probe', () => ({
  probeHermesProfileGateway: vi.fn(async (profile: string) => ({
    available: true,
    detail: `hermes gateway mock://${profile}`,
  })),
  clearHermesGatewayProbeCache: vi.fn(),
}))

let tempRoot: string

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-test-'))
})

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('agents-config', () => {
  it('loads a valid registry with capabilities inheritance', () => {
    const registry = loadAgentsRegistry({
      rawYaml: `
version: 1
agents:
  - id: developer
    runtime: hermes
    profile: developer
  - id: cc-impl
    runtime: claude-code
    command: claude
    args: ["-p"]
`,
      swarmCapabilities: new Map([['developer', ['code', 'test']]]),
    })
    expect(registry.agents).toHaveLength(2)
    const dev = registry.byId.get('developer')
    expect(dev?.runtime).toBe('hermes')
    expect(dev?.capabilities).toEqual(['code', 'test']) // inherited
    expect(registry.byId.get('cc-impl')?.command).toBe('claude')
  })

  it('rejects runtime!=hermes with execution=ssh', () => {
    expect(() =>
      loadAgentsRegistry({
        rawYaml: `
version: 1
agents:
  - id: bad
    runtime: claude-code
    command: claude
    execution: ssh
`,
      }),
    ).toThrow(/execution=ssh is only supported for runtime=hermes/)
  })

  it('rejects unknown runtime and missing command', () => {
    expect(() =>
      loadAgentsRegistry({
        rawYaml: `
version: 1
agents:
  - id: x
    runtime: bogus
`,
      }),
    ).toThrow(/unknown runtime/)
    expect(() =>
      loadAgentsRegistry({
        rawYaml: `
version: 1
agents:
  - id: y
    runtime: codex
`,
      }),
    ).toThrow(/requires a command/)
  })

  it('reports orphan hermes profiles not declared in agents.yaml', () => {
    // Whatever profiles exist on this machine, none declared → all orphan.
    const registry = loadAgentsRegistry({ rawYaml: 'version: 1\nagents: []\n' })
    expect(Array.isArray(registry.orphanProfiles)).toBe(true)
  })

  it('always surfaces the implicit default profile', () => {
    const registry = loadAgentsRegistry({ rawYaml: 'version: 1\nagents: []\n' })
    expect(registry.orphanProfiles).toContain('default')
  })

  it('empty/missing agents.yaml yields empty registry without throwing', () => {
    const registry = loadAgentsRegistry({ repoRoot: tempRoot })
    expect(registry.agents).toEqual([])
  })
})

describe('pid-registry', () => {
  it('register / lookup / unregister roundtrip', () => {
    registerPid(
      {
        runId: 'r1',
        agentId: 'a1',
        pid: 999999,
        runtime: 'claude-code',
        startedAt: 1,
        logPath: '/tmp/x',
      },
      tempRoot,
    )
    expect(lookupPid('r1', tempRoot)?.pid).toBe(999999)
    expect(listPids(tempRoot)).toHaveLength(1)
    unregisterPid('r1', tempRoot)
    expect(lookupPid('r1', tempRoot)).toBeNull()
    expect(listPids(tempRoot)).toHaveLength(0)
  })

  it('register replaces an existing entry for the same runId', () => {
    registerPid(
      {
        runId: 'r1',
        agentId: 'a1',
        pid: 1,
        runtime: 'x',
        startedAt: 1,
        logPath: '/a',
      },
      tempRoot,
    )
    registerPid(
      {
        runId: 'r1',
        agentId: 'a1',
        pid: 2,
        runtime: 'x',
        startedAt: 2,
        logPath: '/b',
      },
      tempRoot,
    )
    expect(listPids(tempRoot)).toHaveLength(1)
    expect(lookupPid('r1', tempRoot)?.pid).toBe(2)
  })

  it('reconcileRegistry drops dead process groups, keeps live ones', () => {
    // Live detached process
    const child = spawn('sleep', ['30'], { detached: true })
    child.unref()
    const livePid = child.pid!

    registerPid(
      {
        runId: 'live',
        agentId: 'a',
        pid: livePid,
        runtime: 'x',
        startedAt: 1,
        logPath: '/a',
      },
      tempRoot,
    )
    registerPid(
      {
        runId: 'dead',
        agentId: 'a',
        pid: 999999,
        runtime: 'x',
        startedAt: 1,
        logPath: '/b',
      },
      tempRoot,
    )

    expect(isProcessGroupAlive(livePid)).toBe(true)
    expect(isProcessGroupAlive(999999)).toBe(false)

    const survivors = reconcileRegistry(tempRoot)
    expect(survivors.map((s) => s.runId)).toEqual(['live'])
    expect(lookupPid('dead', tempRoot)).toBeNull()

    expect(killProcessGroup(livePid)).toBe(true)
    // After kill, group is gone (may take a tick for reaping)
    expect(isProcessGroupAlive(999999)).toBe(false)
  })

  it('killProcessGroup kills the whole group (children too)', async () => {
    // spawn a group leader that forks a child; kill(-pgid) must reap both
    const child = spawn('bash', ['-c', 'sleep 60 & sleep 60'], {
      detached: true,
    })
    child.unref()
    const pid = child.pid!
    expect(isProcessGroupAlive(pid)).toBe(true)
    killProcessGroup(pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 100))
    expect(isProcessGroupAlive(pid)).toBe(false)
  })
})

describe('AgentRuntimeRouter', () => {
  // The repo .env may configure the managed-agent transport; these tests
  // assert the not-configured fallback path, so pin the env vars to empty.
  beforeEach(() => {
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', '')
    vi.stubEnv('AGORAX_WORKSPACE_ID', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds adapters per runtime; deepseek is declared-but-unavailable', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
  - id: cc
    runtime: claude-code
    command: claude
  - id: cx
    runtime: codex
    command: /definitely-not-a-real-binary-xyz
`,
    })
    expect(router.getAdapter('dev')?.kind).toBe('hermes')
    expect(router.getAdapter('cc')?.kind).toBe('claude-code')
    expect(router.getAdapter('cx')?.kind).toBe('codex')
    // Without managed transport, CC/Codex are unavailable (daemon-only path).
    await expect(router.getAdapter('cc')!.probe()).resolves.toEqual({
      available: false,
      detail: 'Agorax Managed Agent transport is not configured',
    })
    await expect(router.getAdapter('cx')!.probe()).resolves.toEqual({
      available: false,
      detail: 'Agorax Managed Agent transport is not configured',
    })
  })

  it('recognizes cursor and kimi as Agorax Managed Agent slots', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: cursor-impl
    runtime: cursor
    command: cursor-agent
  - id: kimi-impl
    runtime: kimi
    command: kimi
`,
    })

    expect(router.getAdapter('cursor-impl')?.kind).toBe('cursor')
    expect(router.getAdapter('kimi-impl')?.kind).toBe('kimi')
    await expect(router.getAdapter('cursor-impl')!.probe()).resolves.toEqual({
      available: false,
      detail: 'Agorax Managed Agent transport is not configured',
    })
  })

  it('does not route opencode through the local Claude adapter', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: opencode-impl
    runtime: opencode
    command: opencode
`,
    })

    expect(router.getAdapter('opencode-impl')?.kind).toBe('opencode')
    await expect(router.getAdapter('opencode-impl')!.probe()).resolves.toEqual({
      available: false,
      detail: 'Agorax Managed Agent transport is not configured',
    })
  })

  it('routes claude-code and codex through the managed daemon bridge when transport is configured', async () => {
    const transport = {
      probe: vi.fn(async (backend: string) => ({
        available: true,
        detail: `daemon:${backend}`,
      })),
      startRun: vi.fn(async () => ({ runId: 'run-1' })),
      streamEvents: vi.fn(() => (async function* () {})()),
      interrupt: vi.fn(async () => undefined),
    }
    const router = new AgentRuntimeRouter({
      agoraxManagedTransport: transport,
      rawYaml: `
version: 1
agents:
  - id: cc-impl
    runtime: claude-code
    command: claude
  - id: codex-impl
    runtime: codex
    command: codex
`,
    })

    expect(router.getAdapter('cc-impl')?.kind).toBe('claude-code')
    expect(router.getAdapter('codex-impl')?.kind).toBe('codex')
    await expect(router.getAdapter('cc-impl')!.probe()).resolves.toEqual({
      available: true,
      detail: 'daemon:claude-code',
    })
    await expect(router.getAdapter('codex-impl')!.probe()).resolves.toEqual({
      available: true,
      detail: 'daemon:codex',
    })
    expect(transport.probe).toHaveBeenCalledWith('claude-code')
    expect(transport.probe).toHaveBeenCalledWith('codex')
  })

  it('uses the injected Agorax Managed Agent transport when configured', async () => {
    const transport = {
      probe: vi.fn(async () => ({ available: true })),
      startRun: vi.fn(async () => ({ runId: 'run-1' })),
      streamEvents: vi.fn(() => (async function* () {})()),
      interrupt: vi.fn(async () => undefined),
    }
    const router = new AgentRuntimeRouter({
      agoraxManagedTransport: transport,
      rawYaml: `
version: 1
agents:
  - id: cursor-impl
    runtime: cursor
    command: cursor-agent
`,
    })

    expect(router.getAdapter('cursor-impl')?.kind).toBe('cursor')
    await expect(router.getAdapter('cursor-impl')!.probe()).resolves.toEqual({
      available: true,
    })
    expect(transport.probe).toHaveBeenCalledWith('cursor')
  })

  it('hermes stub refuses startRun (existing dispatch path owns it)', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
`,
    })
    await expect(
      router.getAdapter('dev')!.startRun({} as never),
    ).rejects.toThrow(/swarm-dispatch/)
  })

  it('probeAll returns one row per agent with runtime/execution', async () => {
    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
  - id: cc
    runtime: claude-code
    command: /definitely-not-a-real-binary-xyz
`,
    })
    const rows = await router.probeAll()
    expect(rows).toHaveLength(2)
    const cc = rows.find((r) => r.agentId === 'cc')!
    expect(cc.available).toBe(false) // transport not configured
    expect(cc.detail).toMatch(/Managed Agent transport is not configured/)
    const dev = rows.find((r) => r.agentId === 'dev')!
    expect(dev.available).toBe(true) // hermes gateway probe (mocked healthy)
    expect(dev.detail).toMatch(/hermes gateway/)
  })

  it('probeAll coalesces concurrent callers and serves TTL cache', async () => {
    const { probeHermesProfileGateway } = await import(
      './hermes-gateway-probe'
    )
    const probeSpy = vi.mocked(probeHermesProfileGateway)
    probeSpy.mockClear()

    const router = new AgentRuntimeRouter({
      rawYaml: `
version: 1
agents:
  - id: dev
    runtime: hermes
    profile: developer
`,
    })

    const [a, b] = await Promise.all([router.probeAll(), router.probeAll()])
    expect(a).toEqual(b)
    expect(probeSpy).toHaveBeenCalledTimes(1)

    probeSpy.mockClear()
    await router.probeAll()
    expect(probeSpy).toHaveBeenCalledTimes(0)

    probeSpy.mockClear()
    await router.probeAll({ fresh: true })
    expect(probeSpy).toHaveBeenCalledTimes(1)
  })
})
