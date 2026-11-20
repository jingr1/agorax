import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentCommands } from './agent-commands'

const mocks = vi.hoisted(() => ({ options: vi.fn(), identity: vi.fn() }))
vi.mock('./agent-runtime/router', () => ({ getAgentRuntimeRouter: () => ({ registry: { byId: new Map([
  ['cc-impl', { runtime: 'claude-code' }], ['codex-impl', { runtime: 'codex' }], ['default', { runtime: 'hermes' }],
]) } }) }))
vi.mock('./agent-runtime/agorax-managed-agent-http-client', () => ({ AgoraxManagedAgentHttpClient: class { getComposerOptions = mocks.options } }))
vi.mock('./agent-runtime/agorax-managed-agent-session-identity', () => ({ resolveAgoraxManagedSessionIdentity: mocks.identity }))

describe('agent runtime command catalogs', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('AGORAX_MANAGED_AGENT_URL', 'http://127.0.0.1:8788')
    vi.stubEnv('AGORAX_WORKSPACE_ID', 'test-workspace')
    mocks.options.mockResolvedValue({ commands: [{ name: 'compact', description: 'Compact context' }], capabilities: { values: ['compact', 'modelSwitch'] }, slashCommandPolicy: { commandCatalogAuthoritative: true } })
    mocks.identity.mockResolvedValue({ ok: true, agentSessionId: 'canonical-session' })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('resolves canonical session identity and returns real commands and capability IDs', async () => {
    const catalog = await buildAgentCommands('codex-impl', 'display-session')
    expect(mocks.identity).toHaveBeenCalledWith({ agentId: 'codex-impl', sessionId: 'display-session' })
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', agentSessionId: 'canonical-session' }))
    expect(catalog.commands).toEqual([{ name: 'compact', description: 'Compact context' }])
    expect(catalog.capabilities).toMatchObject({ compact: true, modelSwitch: true, review: false })
    expect(catalog.authoritative).toBe(true)
  })

  it('queries the selected provider before a session exists', async () => {
    await buildAgentCommands('cc-impl')
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude-code', agentSessionId: undefined }))
    expect(mocks.identity).not.toHaveBeenCalled()
  })

  it('rejects unknown agents and Hermes rather than using a managed fallback', async () => {
    await expect(buildAgentCommands('missing')).rejects.toThrow('unavailable')
    await expect(buildAgentCommands('default')).rejects.toThrow('unavailable')
    expect(mocks.options).not.toHaveBeenCalled()
  })

  it('does not expose a session when identity resolution rejects ownership', async () => {
    mocks.identity.mockResolvedValue({ ok: false, error: 'session does not belong to this agent' })
    await expect(buildAgentCommands('cc-impl', 'other-session')).rejects.toThrow('does not belong')
    expect(mocks.options).not.toHaveBeenCalled()
  })
})