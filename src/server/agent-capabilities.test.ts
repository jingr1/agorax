import { describe, expect, it, vi } from 'vitest'
import { buildAgentCapabilities } from './agent-capabilities'

vi.mock('./agent-runtime/router', () => ({
  getAgentRuntimeRouter: () => ({ registry: {
    byId: new Map([
      ['cc-impl', { runtime: 'claude-code' }],
      ['default', { runtime: 'hermes', profile: 'default' }],
    ]),
    orphanProfiles: [],
  } }),
}))
vi.mock('./claude-code-settings', () => ({
  readClaudeCodeSettings: () => ({}),
  resolveClaudeCodeCurrentModel: () => '',
  resolveClaudeCodeProvider: () => '',
}))
vi.mock('./codex-settings', () => ({
  readCodexConfig: () => ({}), resolveCodexProviderDisplay: () => '',
}))
vi.mock('./platform-mcp', () => ({ listAgentMcpBindings: () => [
  { name: 'enabled-server', enabled: true, transport: 'stdio', serverId: 'one' },
  { name: 'disabled-server', enabled: false, transport: 'stdio', serverId: 'two' },
] }))
vi.mock('./platform-skills', () => ({ listAgentSkillBindings: () => [] }))
vi.mock('./profiles-browser', () => ({
  readProfile: () => ({ config: {}, path: '/nonexistent-test-profile', hasEnv: false }),
}))

describe('MCP assignment status', () => {
  it.each(['cc-impl', 'default'])('does not claim platform bindings are connected for %s', (agentId) => {
    const servers = buildAgentCapabilities(agentId).mcpServers
    expect(servers.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'enabled-server', status: 'assigned' },
      { name: 'disabled-server', status: 'disabled' },
    ])
  })
})