import { createFileRoute } from '@tanstack/react-router'
import { BEARER_TOKEN } from '../../../server/gateway-capabilities'
import { resolveChatGateway } from '../../../server/chat-gateway'
import { isAuthenticated } from '../../../server/auth-middleware'
import { workspaceProfileScope } from '../../../server/workspace-profile'

/**
 * Only Hermes profiles may pin the proxy. Managed agent ids (cc-impl…) must
 * not become `/p/<id>` multiplex paths — fall back to the active Hermes
 * gateway instead.
 */
function resolveProxyProfile(request: Request, incomingUrl: URL): string | undefined {
  const requested =
    incomingUrl.searchParams.get('profile')?.trim() ||
    request.headers.get('x-hermes-profile')?.trim() ||
    incomingUrl.searchParams.get('agent')?.trim() ||
    undefined
  if (!requested) return undefined
  try {
    const scope = workspaceProfileScope(requested)
    if (scope.runtime === 'hermes' && scope.profileHome) {
      return scope.profileName
    }
  } catch {
    // Unknown scope — do not invent a multiplex path.
  }
  return undefined
}

/**
 * Vanilla hermes-agent (any version through 2026-05) does not expose
 * `/api/available-models` — that's a legacy fork-only endpoint. When the
 * proxy gets a 404, synthesize a compatible response from `/v1/models`
 * filtered by provider so the chat composer / settings dialog don't
 * silently break for users on vanilla agent.
 */
async function fallbackAvailableModels(
  gatewayUrl: string,
  provider: string,
  authHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const res = await fetch(`${gatewayUrl}/v1/models`, { headers: authHeaders })
    if (!res.ok) {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const list = Array.isArray(data?.data) ? data.data : []
    const wanted = provider.toLowerCase()
    const models = list
      .map((m) => {
        const id = typeof m.id === 'string' ? m.id : ''
        if (!id) return null
        const owned =
          typeof m.owned_by === 'string' ? m.owned_by.toLowerCase() : ''
        const idProvider = id.includes('/')
          ? id.split('/')[0].toLowerCase()
          : owned
        if (wanted && idProvider !== wanted) return null
        return { id }
      })
      .filter((m): m is { id: string } => Boolean(m))
    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

async function proxyRequest(request: Request, splat: string) {
  const incomingUrl = new URL(request.url)
  const profile = resolveProxyProfile(request, incomingUrl)
  const gateway = resolveChatGateway(profile)
  const targetPath = splat.startsWith('/') ? splat : `/${splat}`
  const targetUrl = new URL(`${gateway.url}${targetPath}`)
  // Strip Agorax-only routing params before forwarding.
  const forwardSearch = new URLSearchParams(incomingUrl.search)
  forwardSearch.delete('profile')
  forwardSearch.delete('agent')
  targetUrl.search = forwardSearch.toString()

  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')
  headers.delete('x-hermes-profile')
  // Prefer the profile gateway token; fall back to process env / BEARER_TOKEN.
  const bearer =
    gateway.token ||
    process.env.HERMES_API_TOKEN ||
    process.env.CLAUDE_API_TOKEN ||
    BEARER_TOKEN
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    init.body = await request.text()
  }

  const upstream = await fetch(targetUrl, init)
  // Vanilla agent fallback for /api/available-models — synthesize from /v1/models.
  if (
    upstream.status === 404 &&
    request.method.toUpperCase() === 'GET' &&
    /\/api\/available-models\b/.test(targetPath)
  ) {
    const provider = incomingUrl.searchParams.get('provider') || ''
    const authHeaders: Record<string, string> = bearer
      ? { Authorization: `Bearer ${bearer}` }
      : {}
    return fallbackAvailableModels(gateway.url, provider, authHeaders)
  }

  const body = await upstream.text()
  const responseHeaders = new Headers()
  const contentType = upstream.headers.get('content-type')
  if (contentType) responseHeaders.set('content-type', contentType)
  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

export const Route = createFileRoute('/api/hermes-proxy/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
    },
  },
})
