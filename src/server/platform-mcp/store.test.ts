import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureCollabDb, getCollabDbVersion } from '../collab-db'
import {
  addAgentMcpServers,
  createPlatformMcpServer,
  deletePlatformMcpServer,
  getPlatformMcpServer,
  listAgentMcpBindings,
  listPlatformMcpServers,
  removeAgentMcpServer,
  setAgentMcpEnabled,
  updatePlatformMcpServer,
} from './store'

let tempRoot: string
let testDb: string

describe('platform-mcp store', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'platform-mcp-'))
    testDb = join(tempRoot, 'collab.db')
    ensureCollabDb(testDb)
  })

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('applies schema migration v9', () => {
    expect(getCollabDbVersion(testDb)).toBeGreaterThanOrEqual(9)
  })

  it('creates and lists platform MCP servers without exposing config in summary', () => {
    const server = createPlatformMcpServer(
      {
        name: 'GitHub',
        config: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'secret-token' },
        },
      },
      { dbPath: testDb },
    )
    expect(server.name).toBe('github')
    expect(server.transport).toBe('stdio')
    expect(server.config.env).toEqual({ GITHUB_TOKEN: 'secret-token' })

    const listed = listPlatformMcpServers({ dbPath: testDb })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe('github')
    expect(listed[0]?.boundAgentCount).toBe(0)
    expect(listed[0]).not.toHaveProperty('config')
  })

  it('reuses one MCP server across agents via agent_mcp_servers', () => {
    const server = createPlatformMcpServer(
      {
        name: 'docs',
        transport: 'http',
        config: { url: 'https://example.test/mcp' },
      },
      { dbPath: testDb },
    )
    addAgentMcpServers('orchestrator', [server.id], { dbPath: testDb })
    addAgentMcpServers('developer', [server.name], { dbPath: testDb })
    expect(listAgentMcpBindings('orchestrator', { dbPath: testDb })).toHaveLength(
      1,
    )
    expect(listAgentMcpBindings('developer', { dbPath: testDb })).toHaveLength(1)
    expect(listPlatformMcpServers({ dbPath: testDb })[0]?.boundAgentCount).toBe(2)

    setAgentMcpEnabled('developer', server.id, false, { dbPath: testDb })
    expect(
      listAgentMcpBindings('developer', {
        dbPath: testDb,
        enabledOnly: true,
      }),
    ).toHaveLength(0)
    expect(
      listAgentMcpBindings('developer', { dbPath: testDb })[0]?.enabled,
    ).toBe(false)

    removeAgentMcpServer('orchestrator', server.id, { dbPath: testDb })
    expect(listAgentMcpBindings('orchestrator', { dbPath: testDb })).toHaveLength(
      0,
    )
    expect(listPlatformMcpServers({ dbPath: testDb })[0]?.boundAgentCount).toBe(1)
  })

  it('rename keeps bindings by id', () => {
    const server = createPlatformMcpServer(
      { name: 'fetch', config: { command: 'uvx', args: ['mcp-server-fetch'] } },
      { dbPath: testDb },
    )
    addAgentMcpServers('researcher', [server.id], { dbPath: testDb })
    updatePlatformMcpServer(
      server.id,
      { name: 'fetch-v2', config: { command: 'uvx', args: ['mcp-server-fetch'] } },
      { dbPath: testDb },
    )
    const bindings = listAgentMcpBindings('researcher', { dbPath: testDb })
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.serverId).toBe(server.id)
    expect(bindings[0]?.name).toBe('fetch-v2')
  })

  it('delete server sweeps bindings', () => {
    const server = createPlatformMcpServer(
      { name: 'tmp', config: { command: 'true' } },
      { dbPath: testDb },
    )
    addAgentMcpServers('writer', [server.id], { dbPath: testDb })
    expect(deletePlatformMcpServer(server.id, { dbPath: testDb })).toBe(true)
    expect(getPlatformMcpServer(server.id, { dbPath: testDb })).toBeNull()
    expect(listAgentMcpBindings('writer', { dbPath: testDb })).toHaveLength(0)
  })
})
