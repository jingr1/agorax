import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  BEARER_TOKEN,
  HERMES_API,
  CLAUDE_UPGRADE_INSTRUCTIONS,
  ensureGatewayEnhancedProbed,
} from '../../../server/gateway-capabilities'
import {
  requireJsonContentType,
  safeErrorMessage,
} from '../../../server/rate-limit'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import {
  deleteProfileMcpServer,
  resolveMcpProfileName,
} from '../../../server/mcp-profile-config'

const REQUEST_TIMEOUT_MS = 30_000

async function mcpFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (BEARER_TOKEN && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${BEARER_TOKEN}`)
  }
  return fetch(`${HERMES_API}${path}`, { ...init, headers })
}

export const Route = createFileRoute('/api/mcp/$name')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        // DELETE has no body, so requireJsonContentType allows it through.
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck
        const capabilities = await ensureGatewayEnhancedProbed()
        if (!capabilities.mcp && !capabilities.mcpFallback) {
          return json(
            createCapabilityUnavailablePayload('mcp', {
              error: `Gateway does not support /api/mcp. ${CLAUDE_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 503 },
          )
        }
        const name = (params as { name?: string }).name?.trim() || ''
        if (!name) {
          return json(
            { ok: false, error: 'Missing server name' },
            { status: 400 },
          )
        }
        try {
          if (capabilities.mcp) {
            const response = await mcpFetch(
              `/api/mcp/${encodeURIComponent(name)}`,
              {
                method: 'DELETE',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              },
            )
            if (!response.ok) {
              const body = (await response.json().catch(() => ({}))) as Record<
                string,
                unknown
              >
              return json(
                {
                  ok: false,
                  error:
                    (body.error as string) ||
                    `MCP delete failed (${response.status})`,
                },
                { status: response.status || 502 },
              )
            }
            return json({ ok: true })
          }
          const url = new URL(request.url)
          const profile = resolveMcpProfileName(url.searchParams.get('profile'))
          deleteProfileMcpServer(profile, name)
          return json({ ok: true, profile })
        } catch (err) {
          const message = safeErrorMessage(err)
          const status = message.includes('not found') ? 404 : 500
          return json({ ok: false, error: message }, { status })
        }
      },
    },
  },
})
