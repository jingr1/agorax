import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  BEARER_TOKEN,
  HERMES_API,
  CLAUDE_UPGRADE_INSTRUCTIONS,
  ensureGatewayEnhancedProbed,
} from '../../server/gateway-capabilities'
import {
  requireJsonContentType,
  safeErrorMessage,
} from '../../server/rate-limit'
import {
  maskSecretsInPlace,
  normalizeMcpList,
  normalizeMcpServer,
} from '../../server/mcp-normalize'
import { parseMcpServerInput } from '../../server/mcp-input-validate'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { getProbe } from '../../server/mcp-tools-cache'
import {
  listProfileMcpServers,
  resolveMcpProfileName,
  toConfigEntry,
  upsertProfileMcpServer,
} from '../../server/mcp-profile-config'

const KNOWN_CATEGORIES = ['All', 'Connected', 'Failed', 'Disabled'] as const
const REQUEST_TIMEOUT_MS = 30_000

async function mcpFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  // Control-plane refactor: always route to gateway, not dashboard
  const headers = new Headers(init.headers)
  if (BEARER_TOKEN && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${BEARER_TOKEN}`)
  }
  return fetch(`${HERMES_API}${path}`, { ...init, headers })
}

function unavailableListPayload() {
  return {
    ...createCapabilityUnavailablePayload('mcp'),
    servers: [],
    total: 0,
    categories: [...KNOWN_CATEGORIES],
  }
}

export { parseMcpServerInput, unavailableListPayload, toConfigEntry }

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const capabilities = await ensureGatewayEnhancedProbed()
        if (!capabilities.mcp && !capabilities.mcpFallback) {
          return json(unavailableListPayload())
        }
        try {
          const url = new URL(request.url)
          const search = (url.searchParams.get('search') || '')
            .trim()
            .toLowerCase()
          const category = (url.searchParams.get('category') || 'All').trim()
          const profile = resolveMcpProfileName(url.searchParams.get('profile'))

          let servers: ReturnType<typeof normalizeMcpList>
          if (capabilities.mcp) {
            const response = await mcpFetch('/api/mcp', {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            if (!response.ok) {
              return json(
                {
                  ...unavailableListPayload(),
                  error: `MCP list failed (${response.status})`,
                },
                { status: 502 },
              )
            }
            const body = (await response.json().catch(() => null)) as unknown
            servers = normalizeMcpList(body).map((s) => maskSecretsInPlace(s))
          } else {
            // Local fallback — read active (or requested) profile mcp_servers
            servers = listProfileMcpServers(profile)
              .map((s) => maskSecretsInPlace(s))
              .map((s) => {
                const probe = getProbe(s.name)
                if (!probe) return s
                return {
                  ...s,
                  status: probe.status,
                  discoveredToolsCount: probe.toolCount,
                  lastError: probe.error || s.lastError,
                }
              })
          }

          const filtered = servers.filter((s) => {
            if (search) {
              const hay = [s.name, s.url || '', s.command || '', ...s.args]
                .join('\n')
                .toLowerCase()
              if (!hay.includes(search)) return false
            }
            if (category === 'Connected' && s.status !== 'connected')
              return false
            if (category === 'Failed' && s.status !== 'failed') return false
            if (category === 'Disabled' && s.enabled) return false
            return true
          })

          return json({
            servers: filtered,
            total: filtered.length,
            categories: [...KNOWN_CATEGORIES],
            profile,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: safeErrorMessage(err),
              servers: [],
              total: 0,
              categories: [...KNOWN_CATEGORIES],
            },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
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
        try {
          const raw = (await request.json()) as unknown
          const parsed = parseMcpServerInput(raw)
          if (!parsed.ok) {
            return json(
              {
                ok: false,
                error: 'Invalid MCP server payload',
                errors: parsed.errors,
              },
              { status: 400 },
            )
          }
          const input = parsed.value
          if (capabilities.mcp) {
            const response = await mcpFetch('/api/mcp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            const body = (await response.json().catch(() => ({}))) as unknown
            const server = normalizeMcpServer(
              (body as Record<string, unknown>).server ?? body,
            )
            if (!response.ok || !server) {
              const errMsg =
                ((body as Record<string, unknown>).error as
                  | string
                  | undefined) || `MCP create failed (${response.status})`
              return json(
                { ok: false, error: errMsg },
                { status: response.status || 502 },
              )
            }
            return json({ ok: true, server: maskSecretsInPlace(server) })
          }
          const url = new URL(request.url)
          const profile = resolveMcpProfileName(
            url.searchParams.get('profile') ||
              (typeof (raw as Record<string, unknown>).profile === 'string'
                ? ((raw as Record<string, unknown>).profile as string)
                : null),
          )
          const written = upsertProfileMcpServer(profile, input)
          return json({
            ok: true,
            server: maskSecretsInPlace(written),
            profile,
          })
        } catch (err) {
          return json(
            { ok: false, error: safeErrorMessage(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
