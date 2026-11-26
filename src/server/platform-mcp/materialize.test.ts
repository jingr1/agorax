import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { AGORAX_PLATFORM_MCP_MARKER, isPlatformMcpEntry } from '../mcp-profile-config'

let tempRoot: string
let hermesHome: string

vi.mock('../agent-runtime/router', () => ({
  getAgentRuntimeRouter: () => ({
    registry: {
      byId: new Map([
        [
          'developer',
          { id: 'developer', runtime: 'hermes', profile: 'developer' },
        ],
        [
          'cc-impl',
          { id: 'cc-impl', runtime: 'claude-code', profile: undefined },
        ],
      ]),
      orphanProfiles: [] as Array<string>,
    },
  }),
}))

describe('platform-mcp materialize', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'platform-mcp-mat-'))
    hermesHome = join(tempRoot, '.hermes')
    mkdirSync(join(hermesHome, 'profiles', 'developer'), { recursive: true })
    writeFileSync(
      join(hermesHome, 'profiles', 'developer', 'config.yaml'),
      YAML.stringify({
        mcp_servers: {
          private: {
            command: 'echo',
            args: ['private'],
          },
        },
      }),
      'utf-8',
    )
    writeFileSync(join(hermesHome, 'active_profile'), 'developer\n', 'utf-8')
    process.env.HERMES_HOME = hermesHome
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.HERMES_HOME
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('writes enabled platform bindings and preserves private entries', async () => {
    const { ensureCollabDb } = await import('../collab-db')
    ensureCollabDb()
    const { createPlatformMcpServer, addAgentMcpServers } = await import(
      './store'
    )
    const { materializeHermesAgentMcp } = await import('./materialize')

    const server = createPlatformMcpServer({
      name: 'github',
      config: {
        command: 'npx',
        args: ['-y', 'github-mcp'],
        env: { TOKEN: 'x' },
      },
    })
    addAgentMcpServers('developer', [server.id])

    const result = materializeHermesAgentMcp('developer')
    expect(result.runtime).toBe('hermes')
    expect(result.written).toContain('github')

    const cfg = YAML.parse(
      readFileSync(
        join(hermesHome, 'profiles', 'developer', 'config.yaml'),
        'utf-8',
      ),
    ) as { mcp_servers: Record<string, Record<string, unknown>> }
    expect(cfg.mcp_servers.private?.command).toBe('echo')
    expect(cfg.mcp_servers.github?.[AGORAX_PLATFORM_MCP_MARKER]).toBe(true)
    expect(isPlatformMcpEntry(cfg.mcp_servers.github)).toBe(true)
  })

  it('managed agents keep bindings without profile FS write', async () => {
    const { ensureCollabDb } = await import('../collab-db')
    ensureCollabDb()
    const { createPlatformMcpServer, addAgentMcpServers } = await import(
      './store'
    )
    const { materializeAgentMcp } = await import('./materialize')

    createPlatformMcpServer({
      name: 'docs',
      transport: 'http',
      config: { url: 'https://example.test/mcp' },
    })
    addAgentMcpServers('cc-impl', ['docs'])

    const result = materializeAgentMcp('cc-impl')
    expect(result.runtime).toBe('claude-code')
    expect(result.written).toContain('docs')
    expect(result.profile).toBeUndefined()
  })

  it('private same-name wins over platform binding', async () => {
    writeFileSync(
      join(hermesHome, 'profiles', 'developer', 'config.yaml'),
      YAML.stringify({
        mcp_servers: {
          github: { command: 'local-github', args: [] },
        },
      }),
      'utf-8',
    )
    const { ensureCollabDb } = await import('../collab-db')
    ensureCollabDb()
    const { createPlatformMcpServer, addAgentMcpServers } = await import(
      './store'
    )
    const { materializeHermesAgentMcp } = await import('./materialize')

    createPlatformMcpServer({
      name: 'github',
      config: { command: 'platform-github' },
    })
    addAgentMcpServers('developer', ['github'])

    const result = materializeHermesAgentMcp('developer')
    expect(result.skippedPrivate).toContain('github')

    const cfg = YAML.parse(
      readFileSync(
        join(hermesHome, 'profiles', 'developer', 'config.yaml'),
        'utf-8',
      ),
    ) as { mcp_servers: Record<string, Record<string, unknown>> }
    expect(cfg.mcp_servers.github?.command).toBe('local-github')
    expect(cfg.mcp_servers.github?.[AGORAX_PLATFORM_MCP_MARKER]).toBeUndefined()
  })
})
