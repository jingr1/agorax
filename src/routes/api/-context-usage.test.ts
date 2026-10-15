import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/gateway-capabilities', () => ({
  BEARER_TOKEN: '',
  HERMES_API: 'http://127.0.0.1:8642',
  dashboardFetch: vi.fn(),
  ensureGatewayProbed: vi.fn(async () => ({ dashboard: { available: false } })),
  getCapabilities: vi.fn(() => ({ dashboard: { available: false } })),
  shouldUseDashboard: vi.fn(() => false),
}))

vi.mock('../../server/hermes-api', () => ({
  listSessions: vi.fn(async () => []),
}))

vi.mock('../../server/local-session-store', () => ({
  getLocalMessages: vi.fn(() => []),
  getLocalSession: vi.fn(() => null),
}))

vi.mock('../../server/run-store', () => ({
  getActiveRunForSession: vi.fn(async () => null),
}))

import {
  dashboardFetch,
  ensureGatewayProbed,
  getCapabilities,
  shouldUseDashboard,
} from '../../server/gateway-capabilities'
import { listSessions } from '../../server/hermes-api'
import {
  getLocalMessages,
  getLocalSession,
} from '../../server/local-session-store'
import {
  computeThresholdTokens,
  estimateContextTokensFromCacheRead,
  estimateContextTokensFromMessages,
  estimateContextTokensFromSessionUsage,
  parseCompressionSettings,
  readContextUsage,
  resolvePreferredContextWindow,
} from '../../server/context-usage'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  // clearAllMocks does not drop mockImplementation — reset so a prior test's
  // dashboardFetch stub cannot leak into fetch-based cases.
  vi.mocked(dashboardFetch).mockReset()
  vi.mocked(ensureGatewayProbed).mockResolvedValue({
    dashboard: { available: false },
  } as any)
  vi.mocked(getCapabilities).mockReturnValue({
    dashboard: { available: false },
  } as any)
})

describe('context usage estimation', () => {
  it('prefers live gateway runtime snapshots when the vanilla runtime endpoint is available', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/sessions/session-123/runtime')) {
        return jsonResponse({
          model: 'anthropic/claude-sonnet-4-20250514',
          context_tokens: 4321,
          context_length: 200000,
          context_percent: 2,
          prompt_tokens: 111,
          completion_tokens: 22,
          total_tokens: 133,
        })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'anthropic/claude-sonnet-4-20250514',
          effective_context_length: 200000,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('session-123')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/api/sessions/session-123/runtime',
      expect.objectContaining({ headers: {}, signal: expect.any(AbortSignal) }),
    )
    expect(snapshot).toMatchObject({
      ok: true,
      model: 'anthropic/claude-sonnet-4-20250514',
      usedTokens: 4321,
      maxTokens: 200000,
      contextPercent: 2,
      conversationTokens: 4321,
      thresholdTokens: 100000,
    })
  })

  it('ignores incomplete /runtime payloads that only have cache totals (no 0/0 meter)', async () => {
    vi.mocked(getLocalSession).mockReturnValue(null as any)
    vi.mocked(getLocalMessages).mockReturnValue([] as any)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/sessions/session-empty/runtime')) {
        return jsonResponse({
          model: 'Kimi-K3',
          cache_read_tokens: 92_100_000,
          cache_write_tokens: 0,
          // missing context_tokens / context_length — previously painted 0/0
        })
      }
      if (
        url.includes('/api/sessions/session-empty') &&
        !url.includes('/runtime')
      ) {
        return jsonResponse({
          session: {
            id: 'session-empty',
            model: 'Kimi-K3',
            message_count: 0,
            cache_read_tokens: 92_100_000,
            cache_write_tokens: 0,
          },
        })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'Kimi-K3',
          effective_context_length: 1_048_576,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('session-empty')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'Kimi-K3',
      maxTokens: 1_048_576,
      usedTokens: 0,
      contextPercent: 0,
      thresholdTokens: 524_288,
      cacheReadTokens: 92_100_000,
    })
    expect(snapshot.cacheHitPercent).toBeNull()
  })

  it('reads /api/model/info from the gateway without Dashboard :9119', async () => {
    vi.mocked(getLocalSession).mockReturnValue(null as any)
    vi.mocked(getLocalMessages).mockReturnValue([] as any)
    vi.mocked(getCapabilities).mockReturnValue({
      dashboard: { available: false },
    } as any)
    vi.mocked(ensureGatewayProbed).mockResolvedValue({
      dashboard: { available: false },
    } as any)
    vi.mocked(shouldUseDashboard).mockReturnValue(false)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'Kimi-K2.7-Code',
          effective_context_length: 262_144,
          auto_context_length: 262_144,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      if (url.includes('/runtime')) {
        return new Response('not found', { status: 404 })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('new')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'Kimi-K2.7-Code',
      maxTokens: 262_144,
      usedTokens: 0,
      contextPercent: 0,
      thresholdTokens: 131_072,
    })
    expect(dashboardFetch).not.toHaveBeenCalled()
  })

  it('resolves main to the canonical Hermes session id before reading runtime usage', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: 'session-abc',
        title: 'Live chat',
        message_count: 12,
      },
    ] as any)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/sessions/session-abc/runtime')) {
        return jsonResponse({
          model: 'gpt-5.4',
          context_tokens: 86397,
          context_length: 512000,
          context_percent: 17,
        })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'gpt-5.4',
          effective_context_length: 512000,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('main')

    expect(listSessions).toHaveBeenCalledWith(30, 0)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/api/sessions/session-abc/runtime',
      expect.objectContaining({ headers: {}, signal: expect.any(AbortSignal) }),
    )
    expect(snapshot).toMatchObject({
      ok: true,
      model: 'gpt-5.4',
      usedTokens: 86397,
      maxTokens: 512000,
      contextPercent: 17,
      thresholdTokens: 256000,
    })
  })

  it('prefers gateway context length for local Workspace-only chats', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'local-1',
      model: null,
    } as any)
    vi.mocked(getLocalMessages).mockReturnValue([
      { content: 'x'.repeat(700) },
    ] as any)
    vi.mocked(shouldUseDashboard).mockReturnValue(false)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/sessions/local-1/runtime')) {
        return new Response('not found', { status: 404 })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'gpt-5.4',
          effective_context_length: 512000,
          config_context_length: 512000,
        })
      }
      return new Response('unexpected', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('local-1')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'gpt-5.4',
      maxTokens: 512000,
      usedTokens: 200,
      contextPercent: 0,
      thresholdTokens: 256000,
    })
    expect(dashboardFetch).not.toHaveBeenCalled()
  })

  it('uses gateway effective_context_length for Kimi-K3 instead of the 200k hardcoded fallback', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'local-kimi',
      model: 'Kimi-K3',
    } as any)
    vi.mocked(getLocalMessages).mockReturnValue([
      { content: 'x'.repeat(700) },
    ] as any)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/runtime')) {
        return new Response('not found', { status: 404 })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'Kimi-K3',
          effective_context_length: 1_048_576,
          auto_context_length: 1_048_576,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('local-kimi')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'Kimi-K3',
      maxTokens: 1_048_576,
      thresholdTokens: 524_288,
    })
    expect(snapshot.contextPercent).toBeLessThan(1)
  })

  it('derives Auto-compress threshold from compression.threshold in config.yaml', async () => {
    vi.mocked(getLocalSession).mockReturnValue(null as any)
    vi.mocked(getLocalMessages).mockReturnValue([] as any)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'Kimi-K3',
          effective_context_length: 200000,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('new')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'Kimi-K3',
      maxTokens: 200000,
      // 50% of 200k — matches yaml, not the old hardcoded 75%
      thresholdTokens: 100000,
    })
  })

  it('maps a mirrored local chat to the nearest real Hermes runtime session even when the runtime session has zero stored messages', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'local-mirror',
      model: null,
      createdAt: 1_000_000,
      updatedAt: 2_000_000,
    } as any)
    vi.mocked(getLocalMessages).mockReturnValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ] as any)

    vi.mocked(listSessions).mockResolvedValue([
      {
        id: 'runtime-nearest',
        started_at: 2000.01,
        last_active: 2100,
        message_count: 0,
      },
      {
        id: 'runtime-older',
        started_at: 1800,
        last_active: 1900,
        message_count: 12,
      },
    ] as any)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/sessions/local-mirror/runtime')) {
        return new Response('not found', { status: 404 })
      }
      if (url.includes('/api/sessions/runtime-nearest/runtime')) {
        return jsonResponse({
          model: 'gpt-5.4',
          context_tokens: 85028,
          context_length: 512000,
          context_percent: 17,
        })
      }
      if (url.includes('/api/sessions/runtime-older/runtime')) {
        return jsonResponse({
          model: 'gpt-5.4',
          context_tokens: 19266,
          context_length: 512000,
          context_percent: 4,
        })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'gpt-5.4',
          effective_context_length: 512000,
        })
      }
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('local-mirror')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'gpt-5.4',
      usedTokens: 85028,
      maxTokens: 512000,
      contextPercent: 17,
    })
  })

  it('keeps configured context length visible for unresolved synthetic sessions like new', async () => {
    vi.mocked(getLocalSession).mockReturnValue(null as any)
    vi.mocked(getLocalMessages).mockReturnValue([] as any)
    vi.mocked(shouldUseDashboard).mockReturnValue(false)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'gpt-5.4',
          effective_context_length: 512000,
          config_context_length: 512000,
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('new')

    expect(snapshot).toMatchObject({
      ok: true,
      model: 'gpt-5.4',
      maxTokens: 512000,
      usedTokens: 0,
      contextPercent: 0,
      thresholdTokens: 256000,
    })
  })

  it('counts serialized content arrays and tool results instead of only string lengths', () => {
    const tokens = estimateContextTokensFromMessages([
      {
        content: [{ type: 'text', text: 'hello world' }],
      },
      {
        content: [
          {
            type: 'tool_result',
            text: 'x'.repeat(400),
          },
        ],
      },
    ])

    expect(tokens).toBeGreaterThan(100)
  })

  it('uses structured message estimation for local sessions instead of string-only content lengths', async () => {
    vi.mocked(getLocalSession).mockReturnValue({
      id: 'local-structured',
      model: null,
    } as any)
    vi.mocked(getLocalMessages).mockReturnValue([
      {
        content: [{ type: 'tool_result', text: 'x'.repeat(400) }],
      },
    ] as any)
    vi.mocked(shouldUseDashboard).mockReturnValue(false)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/config')) {
        return jsonResponse({ compression: { threshold: 0.5 } })
      }
      if (url.includes('/api/model/info')) {
        return jsonResponse({
          model: 'gpt-5.4',
          effective_context_length: 512000,
          config_context_length: 512000,
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await readContextUsage('local-structured')

    expect(snapshot.usedTokens).toBeGreaterThan(0)
    expect(snapshot.maxTokens).toBe(512000)
  })

  it('does not double-count top-level text when it mirrors structured content', () => {
    const mirroredToolOutput = JSON.stringify({ output: 'x'.repeat(4000) })
    const withMirroredText = estimateContextTokensFromMessages([
      {
        content: [{ type: 'tool_result', text: mirroredToolOutput }],
        text: mirroredToolOutput,
      },
    ])
    const contentOnly = estimateContextTokensFromMessages([
      {
        content: [{ type: 'tool_result', text: mirroredToolOutput }],
      },
    ])

    expect(withMirroredText).toBe(contentOnly)
  })

  it('keeps cumulative cache-read totals as a fallback, not the primary estimate', () => {
    const messageEstimate = estimateContextTokensFromMessages([
      { content: 'x'.repeat(4_000) },
    ])
    const cacheEstimate = estimateContextTokensFromCacheRead(14_100_480, 123)

    expect(messageEstimate).toBeLessThan(cacheEstimate)
    expect(messageEstimate).toBeGreaterThan(1000)
    expect(messageEstimate).toBeLessThan(1200)
  })

  it('estimates context from average input tokens per API call', () => {
    const estimate = estimateContextTokensFromSessionUsage(21019, 31360, 0, 9)

    expect(estimate).toBe(5820)
  })

  it('sums input, cache_read, and cache_write before averaging', () => {
    const estimate = estimateContextTokensFromSessionUsage(5000, 3000, 2000, 5)

    expect(estimate).toBe(2000)
  })

  it('handles zero API calls by treating as a single call', () => {
    const estimate = estimateContextTokensFromSessionUsage(10000, 0, 0, 0)

    expect(estimate).toBe(10000)
  })

  it('handles missing or NaN token fields as zero', () => {
    const estimate = estimateContextTokensFromSessionUsage(NaN, NaN, NaN, 5)

    expect(estimate).toBe(0)
  })

  it('returns near-accurate context for a session with many internal API calls but few user messages', () => {
    const cacheEstimate = estimateContextTokensFromCacheRead(3881216, 119)
    const usageEstimate = estimateContextTokensFromSessionUsage(
      203530,
      3881216,
      0,
      59,
    )

    expect(usageEstimate).toBeLessThan(cacheEstimate)
    expect(usageEstimate).toBe(69233)
  })
})

describe('context window + compression threshold helpers', () => {
  it('prefers gateway effective length over the static model table', () => {
    expect(resolvePreferredContextWindow('gpt-5.4', 512000)).toBe(512000)
    expect(resolvePreferredContextWindow('Kimi-K3', 1_048_576)).toBe(1_048_576)
    expect(resolvePreferredContextWindow('gpt-5.4', undefined, 272000)).toBe(
      272000,
    )
  })

  it('parses compression.threshold from Hermes config and matches agent math', () => {
    expect(
      parseCompressionSettings({ compression: { threshold: 0.5 } }),
    ).toEqual({
      thresholdRatio: 0.5,
      thresholdTokensCap: 0,
    })
    expect(computeThresholdTokens(200000, undefined, 0.5)).toBe(100000)
    expect(computeThresholdTokens(1_048_576, undefined, 0.5)).toBe(524288)
    expect(computeThresholdTokens(200000, undefined, 0.5, 80_000)).toBe(80_000)
    expect(computeThresholdTokens(200000, 150000, 0.5)).toBe(150000)
  })
})
