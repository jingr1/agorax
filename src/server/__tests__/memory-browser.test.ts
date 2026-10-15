import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

const { existsSync, readFileSync, statSync, readdirSync } = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  statSync: vi.fn().mockReturnValue({
    isFile: () => false,
    isDirectory: () => false,
    mtime: new Date(0),
    mtimeMs: 0,
  }),
  readdirSync: vi.fn().mockReturnValue([]),
}))

vi.mock('node:fs', () => ({
  default: { existsSync, readFileSync, statSync, readdirSync },
  existsSync,
  readFileSync,
  statSync,
  readdirSync,
}))

vi.mock('../agent-runtime/agents-config', () => ({
  loadAgentsRegistry: () => ({
    version: 1,
    agents: [
      {
        id: 'orchestrator',
        name: 'Orchestrator',
        runtime: 'hermes',
        profile: 'orchestrator',
      },
      {
        id: 'researcher',
        name: 'Researcher',
        runtime: 'hermes',
        profile: 'researcher',
      },
      {
        id: 'cc-impl',
        name: 'Claude Code',
        runtime: 'claude-code',
      },
      {
        id: 'codex-impl',
        name: 'Codex',
        runtime: 'codex',
      },
    ],
    byId: new Map([
      [
        'orchestrator',
        {
          id: 'orchestrator',
          name: 'Orchestrator',
          runtime: 'hermes',
          profile: 'orchestrator',
        },
      ],
      [
        'researcher',
        {
          id: 'researcher',
          name: 'Researcher',
          runtime: 'hermes',
          profile: 'researcher',
        },
      ],
      ['cc-impl', { id: 'cc-impl', name: 'Claude Code', runtime: 'claude-code' }],
      ['codex-impl', { id: 'codex-impl', name: 'Codex', runtime: 'codex' }],
    ]),
    orphanProfiles: ['default'],
  }),
}))

const { homedir } = vi.hoisted(() => ({
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}))

vi.mock('node:os', () => ({
  default: { homedir },
  homedir,
}))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.HERMES_HOME
  existsSync.mockReturnValue(false)
  readdirSync.mockReturnValue([])
  statSync.mockReturnValue({
    isFile: () => false,
    isDirectory: () => false,
    mtime: new Date(0),
    mtimeMs: 0,
  })
})

async function loadMod() {
  vi.resetModules()
  return import('../memory-browser')
}

describe('memory-browser', () => {
  it('normalizes workspace root with HERMES_HOME via path.resolve', async () => {
    process.env.HERMES_HOME = '/custom/hermes'
    const mod = await loadMod()
    const root = mod.getMemoryWorkspaceRoot()
    expect(root).toBe(path.resolve('/custom/hermes'))
  })

  it('falls back to ~/.hermes when HERMES_HOME is not set', async () => {
    const mod = await loadMod()
    const root = mod.getMemoryWorkspaceRoot()
    expect(root).toBe(path.resolve('/home/testuser/.hermes'))
  })

  it('uses path.resolve on env path with trailing slash', async () => {
    process.env.HERMES_HOME = '/custom/hermes/'
    const mod = await loadMod()
    const root = mod.getMemoryWorkspaceRoot()
    expect(root).toBe(path.resolve('/custom/hermes'))
  })

  it('resolves named agent memory under profiles/<agent>', async () => {
    process.env.HERMES_HOME = '/custom/hermes'
    const mod = await loadMod()
    expect(mod.getMemoryWorkspaceRoot('orchestrator')).toBe(
      path.resolve('/custom/hermes/profiles/orchestrator'),
    )
  })

  it('lists hermes agents and managed homes from their own directories', async () => {
    process.env.HERMES_HOME = '/custom/hermes'
    existsSync.mockImplementation((p: string) => {
      const value = String(p)
      return (
        value.endsWith(`${path.sep}.claude`) ||
        value.endsWith(`${path.sep}.codex`) ||
        value.includes(`${path.sep}profiles`)
      )
    })
    readdirSync.mockImplementation((dirPath: string) => {
      if (String(dirPath).endsWith(`${path.sep}profiles`)) {
        return [
          {
            name: 'orchestrator',
            isDirectory: () => true,
            isSymbolicLink: () => false,
          },
          {
            name: 'researcher',
            isDirectory: () => true,
            isSymbolicLink: () => false,
          },
        ]
      }
      if (String(dirPath).endsWith(`${path.sep}.claude`)) {
        return []
      }
      if (String(dirPath).endsWith(`${path.sep}projects`)) {
        return []
      }
      return []
    })
    statSync.mockImplementation((p: string) => {
      const value = String(p)
      if (value.endsWith(`${path.sep}CLAUDE.md`)) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          mtime: new Date('2026-01-01T00:00:00Z'),
          size: 12,
        }
      }
      return {
        isFile: () => false,
        isDirectory: () => true,
        mtime: new Date(0),
        mtimeMs: 0,
      }
    })

    const mod = await loadMod()
    const agents = mod.listMemoryAgents()
    expect(agents.map((agent) => agent.id)).toEqual([
      'default',
      'orchestrator',
      'researcher',
      'cc-impl',
      'codex-impl',
    ])
    const claude = agents.find((agent) => agent.id === 'cc-impl')
    expect(claude?.memoryKind).toBe('claude-code')
    expect(claude?.root).toBe(path.resolve('/home/testuser/.claude'))
    expect(claude?.rootHint).toContain('.claude')
  })
})
