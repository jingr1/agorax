import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  HERMES_UPGRADE_INSTRUCTIONS,
  ensureGatewayEnhancedProbed,
} from '../../../server/gateway-capabilities'
import { resolveChatGateway } from '../../../server/chat-gateway'
import {
  requireJsonContentType,
  safeErrorMessage,
} from '../../../server/rate-limit'
import { normalizeTestResult } from '../../../server/mcp-normalize'
import { parseMcpServerInput } from '../../../server/mcp-input-validate'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { resolveMcpProfileName } from '../../../server/mcp-profile-config'

const DISCOVER_TIMEOUT_MS = 30_000

async function mcpFetch(
  path: string,
  init: RequestInit,
  profileName?: string,
): Promise<Response> {
  const gateway = resolveChatGateway(profileName)
  const headers = new Headers(init.headers)
  if (gateway.token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${gateway.token}`)
  }
  return fetch(`${gateway.url}${path}`, { ...init, headers })
}

export const Route = createFileRoute('/api/mcp/discover')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        const capabilities = await ensureGatewayEnhancedProbed()
        if (capabilities.mcpFallback && !capabilities.mcp) {
          // Phase 1.5: live discover requires the runtime endpoint.
          return json({
            ok: false,
            status: 'unknown',
            discoveredTools: [],
            error:
              'Live test/discover requires hermes-agent /api/mcp runtime endpoint, not yet available on this dashboard.',
          })
        }
        if (!capabilities.mcp) {
          return json(
            createCapabilityUnavailablePayload('mcp', {
              error: `Gateway does not support /api/mcp. ${HERMES_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 503 },
          )
        }
        try {
          const raw = (await request.json()) as unknown
          const url = new URL(request.url)
          const profile =
            resolveMcpProfileName(
              url.searchParams.get('profile') ||
                (raw &&
                typeof raw === 'object' &&
                typeof (raw as Record<string, unknown>).profile === 'string'
                  ? ((raw as Record<string, unknown>).profile as string)
                  : null),
            ) ?? undefined
          const parsed = parseMcpServerInput(raw)
          if (!parsed.ok) {
            return json(
              {
                ok: false,
                error: 'Invalid MCP discover payload',
                errors: parsed.errors,
              },
              { status: 400 },
            )
          }
          const input = parsed.value
          const response = await mcpFetch(
            '/api/mcp/discover',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
            },
            profile,
          )
          const payload = (await response.json().catch(() => ({}))) as unknown
          const result = normalizeTestResult(payload)
          return json(
            {
              ok: result.ok,
              tools: result.discoveredTools,
              error: result.error,
            },
            { status: response.ok ? 200 : response.status || 502 },
          )
        } catch (err) {
          return json(
            { ok: false, tools: [], error: safeErrorMessage(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
