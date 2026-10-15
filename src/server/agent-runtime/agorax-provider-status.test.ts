import { describe, expect, it, vi } from 'vitest'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from './agorax-managed-agent-http-client'
import {
  AGENT_PROVIDER_BADGE_LABELS,
  AGENT_PROVIDER_IDS,
  providerIdForAgentRuntime,
  providerStatusBadge,
  type AgentProviderStatusListDto,
} from '@/lib/managed-agent-runtime/provider-status'

const statusBody: AgentProviderStatusListDto = {
  capturedAt: '2026-09-18T00:00:00Z',
  providers: [
    {
      provider: 'claude-code',
      targetId: 'local:claude-code',
      registered: true,
      installed: true,
      binaryPath: '/usr/local/bin/claude',
      version: '2.1.0',
      latestVersion: '2.1.0',
      updateAvailable: false,
      auth: { status: 'authenticated', accountLabel: 'dev@example.com' },
      install: {
        kind: 'official_script',
        displayCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
        packageName: '',
        binaryName: 'claude',
        managedNpm: false,
      },
      update: {
        capability: 'unsupported',
        source: '',
        unsupportedReason: 'official_script_update_unsupported',
      },
    },
  ],
}

function mockFetch(body: unknown, status = 200): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function clientFor(fetchImpl: typeof fetch): AgoraxManagedAgentHttpClient {
  return new AgoraxManagedAgentHttpClient({
    baseUrl: 'http://127.0.0.1:19130/',
    workspaceId: 'default',
    fetchImpl,
  })
}

describe('AgoraxManagedAgentHttpClient provider runtime surfaces', () => {
  it('GETs the daemon provider-status aggregate', async () => {
    const { fetchImpl, calls } = mockFetch(statusBody)
    const status = await clientFor(fetchImpl).getProviderStatus()

    expect(calls[0]?.url).toBe('http://127.0.0.1:19130/v1/provider-status')
    expect(calls[0]?.init.method).toBe('GET')
    expect(status.providers[0]?.install?.kind).toBe('official_script')
    expect(status.providers[0]?.install?.displayCommand).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    )
    expect(status.providers[0]?.install?.managedNpm).toBe(false)
  })

  it('POSTs an install without a version as an empty body', async () => {
    const { fetchImpl, calls } = mockFetch({ provider: 'codex', status: 'installed' })
    const result = await clientFor(fetchImpl).installProvider('codex')

    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:19130/v1/providers/codex/install',
    )
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({})
    expect(result.status).toBe('installed')
  })

  it('POSTs an install with an explicit version', async () => {
    const { fetchImpl, calls } = mockFetch({ provider: 'codex', status: 'already' })
    await clientFor(fetchImpl).installProvider('codex', { version: '0.153.4' })

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      provider: undefined,
      version: '0.153.4',
    })
  })

  it('URL-encodes the provider path segment', async () => {
    const { fetchImpl, calls } = mockFetch({ status: 'already' })
    await clientFor(fetchImpl).installProvider('kimi-code')
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:19130/v1/providers/kimi-code/install',
    )
  })

  it('surfaces the daemon error body on the thrown error', async () => {
    const { fetchImpl } = mockFetch(
      { error: 'an install for "codex" is already in progress' },
      409,
    )
    const error = await clientFor(fetchImpl)
      .installProvider('codex')
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgoraxManagedAgentHttpError)
    expect((error as AgoraxManagedAgentHttpError).status).toBe(409)
    expect((error as AgoraxManagedAgentHttpError).detail).toContain(
      'already in progress',
    )
  })
})

describe('providerStatusBadge', () => {
  const base = { installed: true, updateAvailable: false, error: '' }

  it('maps missing entries to unknown', () => {
    expect(providerStatusBadge(undefined)).toBe('unknown')
  })

  it('maps uninstalled providers to not-installed even with probe errors', () => {
    expect(
      providerStatusBadge({ installed: false, updateAvailable: false, error: 'boom' }),
    ).toBe('not-installed')
  })

  it('maps update-available providers ahead of ready', () => {
    expect(providerStatusBadge({ ...base, updateAvailable: true })).toBe(
      'update-available',
    )
  })

  it('maps probe errors on installed providers to unknown', () => {
    expect(providerStatusBadge({ ...base, error: 'version probe: timeout' })).toBe(
      'unknown',
    )
  })

  it('maps healthy installs to ready', () => {
    expect(providerStatusBadge(base)).toBe('ready')
  })

  it('covers every badge with a label', () => {
    for (const badge of ['ready', 'update-available', 'not-installed', 'unknown'] as const) {
      expect(AGENT_PROVIDER_BADGE_LABELS[badge]).toBeTruthy()
    }
  })
})

describe('providerIdForAgentRuntime', () => {
  it('maps managed runtimes to daemon provider ids', () => {
    expect(providerIdForAgentRuntime('claude-code')).toBe('claude-code')
    expect(providerIdForAgentRuntime('codex')).toBe('codex')
    expect(providerIdForAgentRuntime('cursor')).toBe('cursor')
    expect(providerIdForAgentRuntime('opencode')).toBe('opencode')
    expect(providerIdForAgentRuntime('kimi')).toBe('kimi-code')
  })

  it('returns null for runtimes the daemon does not detect', () => {
    expect(providerIdForAgentRuntime('hermes')).toBeNull()
    expect(providerIdForAgentRuntime('deepseek-harness')).toBeNull()
  })

  it('stays in sync with the daemon provider catalog', () => {
    for (const provider of ['claude-code', 'codex', 'cursor', 'opencode', 'kimi-code']) {
      expect(AGENT_PROVIDER_IDS).toContain(provider)
    }
  })
})
