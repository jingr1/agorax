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
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import {
  deleteProfileMcpServer,
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
              error: `Gateway does not support /api/mcp. ${HERMES_UPGRADE_INSTRUCTIONS}`,
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
          const url = new URL(request.url)
          const profile = resolveMcpProfileName(url.searchParams.get('profile'))
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
              `/api/mcp/${encodeURIComponent(name)}`,
              {
                method: 'DELETE',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              },
              profile,
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
