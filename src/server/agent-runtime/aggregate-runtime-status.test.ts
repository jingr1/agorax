import { describe, expect, it, vi } from 'vitest'

vi.mock('../update-system', () => ({
  readAgentUpdateStatus: () => ({
    path: '/usr/bin/hermes',
    version: '0.21.4',
    installKind: 'git',
    updateAvailable: false,
    canUpdate: false,
    latestHead: null,
    state: 'ok',
    branch: 'main',
    reason: null,
  }),
}))

vi.mock('./hermes-gateway-probe', () => ({
  probeHermesProfileGateway: async () => ({ available: true }),
}))

import { aggregateAgentRuntimeStatus } from './aggregate-runtime-status'
import type { AgentProviderStatusListDto } from '@/lib/managed-agent-runtime/provider-status'

describe('aggregateAgentRuntimeStatus', () => {
  it('keeps managed provider rows when the daemon is unreachable', async () => {
    const status = await aggregateAgentRuntimeStatus(null)
    const ids = status.providers.map((entry) => entry.provider)
    expect(ids).toEqual([
      'hermes',
      'claude-code',
      'codex',
      'cursor',
      'opencode',
      'kimi-code',
      'deepseek-harness',
    ])
    const claude = status.providers.find((entry) => entry.provider === 'claude-code')
    expect(claude?.error).toBe('managed_agent_daemon_unreachable')
    expect(claude?.installed).toBe(false)
    expect(claude?.install?.kind).toBe('official_script')
    expect(claude?.install?.displayCommand).toContain('claude.ai/install.sh')
  })

  it('uses live daemon rows when the daemon responds', async () => {
    const daemonStatus: AgentProviderStatusListDto = {
      capturedAt: '2026-09-24T00:00:00Z',
      providers: [
        {
          provider: 'codex',
          targetId: 'local:codex',
          registered: true,
          installed: true,
          updateAvailable: false,
          auth: { status: 'authenticated' },
          update: { capability: 'supported', source: 'npm' },
        },
      ],
    }
    const status = await aggregateAgentRuntimeStatus(daemonStatus)
    expect(status.providers.map((entry) => entry.provider)).toEqual([
      'hermes',
      'codex',
      'deepseek-harness',
    ])
    const codex = status.providers.find((entry) => entry.provider === 'codex')
    expect(codex?.installed).toBe(true)
    expect(codex?.error).toBeUndefined()
  })

  it('fills a missing install DTO from the catalog so Install stays available', async () => {
    const daemonStatus: AgentProviderStatusListDto = {
      capturedAt: '2026-09-24T00:00:00Z',
      providers: [
        {
          provider: 'kimi-code',
          targetId: 'extension:kimi-code',
          registered: false,
          installed: false,
          updateAvailable: false,
          auth: { status: 'unknown' },
          update: { capability: 'unsupported' },
        },
      ],
    }
    const status = await aggregateAgentRuntimeStatus(daemonStatus)
    const kimi = status.providers.find((entry) => entry.provider === 'kimi-code')
    expect(kimi?.install?.kind).toBe('official_script')
    expect(kimi?.install?.displayCommand).toContain('code.kimi.com')
    expect(kimi?.install?.binaryName).toBe('kimi')
  })
})
