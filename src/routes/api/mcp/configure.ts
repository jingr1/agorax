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
import {
  maskSecretsInPlace,
  normalizeMcpServer,
} from '../../../server/mcp-normalize'
import type { McpConfigureInput } from '../../../types/mcp-input'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import {
  patchProfileMcpServer,
  resolveMcpProfileName,
} from '../../../server/mcp-profile-config'

const REQUEST_TIMEOUT_MS = 30_000

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

function readConfigure(raw: unknown): McpConfigureInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return null
  const out: McpConfigureInput = { name }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (
    r.toolMode === 'all' ||
    r.toolMode === 'include' ||
    r.toolMode === 'exclude'
  ) {
    out.toolMode = r.toolMode
  }
  if (Array.isArray(r.includeTools)) {
    out.includeTools = (r.includeTools as Array<unknown>).map((t) => String(t))
  }
  if (Array.isArray(r.excludeTools)) {
    out.excludeTools = (r.excludeTools as Array<unknown>).map((t) => String(t))
  }
  return out
}

export const Route = createFileRoute('/api/mcp/configure')({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        const capabilities = await ensureGatewayEnhancedProbed()
        if (!capabilities.mcp && !capabilities.mcpFallback) {
          return json(
            createCapabilityUnavailablePayload('mcp', {
              error: `Gateway does not support /api/mcp. ${HERMES_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 503 },
          )
        }
        try {
          const raw = (await request.json()) as unknown
          const input = readConfigure(raw)
          if (!input) {
            return json(
              { ok: false, error: 'Invalid configure payload' },
              { status: 400 },
            )
          }
          const url = new URL(request.url)
          const profile = resolveMcpProfileName(
            url.searchParams.get('profile') ||
              (typeof (raw as Record<string, unknown>).profile === 'string'
                ? ((raw as Record<string, unknown>).profile as string)
                : null),
          )
          if (!profile) {
            return json(
              {
                ok: false,
                error:
                  'MCP profile config applies to Hermes agents only. Use Library + Agents for managed runtimes.',
              },
              { status: 400 },
            )
          }
          if (capabilities.mcp) {
            const response = await mcpFetch(
              '/api/mcp/configure',
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              },
              profile,
            )
            const body = (await response.json().catch(() => ({}))) as unknown
            const server = normalizeMcpServer(
              (body as Record<string, unknown>).server ?? body,
            )
            if (!response.ok || !server) {
              const errMsg =
                ((body as Record<string, unknown>).error as
                  | string
                  | undefined) || `MCP configure failed (${response.status})`
              return json(
                { ok: false, error: errMsg },
                { status: response.status || 502 },
              )
            }
            return json({ ok: true, server: maskSecretsInPlace(server) })
          }
          const written = patchProfileMcpServer(profile, input.name, {
            enabled: input.enabled,
            toolMode: input.toolMode,
            includeTools: input.includeTools,
            excludeTools: input.excludeTools,
          })
          return json({
            ok: true,
            server: maskSecretsInPlace(written),
            profile,
          })
        } catch (err) {
          const message = safeErrorMessage(err)
          const status = message.includes('not found') ? 404 : 500
          return json({ ok: false, error: message }, { status })
        }
      },
    },
  },
})
