import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from '../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'

const MAX_MESSAGE_PAGE_LIMIT = 1000

function parseVersionQuery(url: URL): { afterVersion?: number; limit?: number } | { error: string } {
  const afterVersionRaw = url.searchParams.get('afterVersion')
  let afterVersion: number | undefined
  if (afterVersionRaw !== null && afterVersionRaw !== '') {
    const parsed = Number(afterVersionRaw)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { error: 'afterVersion must be a non-negative integer' }
    }
    afterVersion = parsed
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null && limitRaw !== '') {
    const parsed = Number(limitRaw)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MESSAGE_PAGE_LIMIT) {
      return { error: `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}` }
    }
    limit = parsed
  }
  return { afterVersion, limit }
}

export const Route = createFileRoute('/api/agents/$agentId/engine/session/$sessionId/messages')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!baseUrl || !workspaceId) {
          return json({ error: 'Managed Agent transport is not configured' }, { status: 503 })
        }
        const query = parseVersionQuery(new URL(request.url))
        if ('error' in query) return json({ error: query.error }, { status: 400 })
        const identity = await resolveAgoraxManagedSessionIdentity({
          agentId: params.agentId,
          sessionId: params.sessionId,
        })
        if (!identity.ok) return json({ error: identity.error }, { status: identity.status })
        try {
          const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
          const page = await client.listSessionMessages(identity.agentSessionId, query)
          return json({
            messages: page.messages,
            latestVersion: page.latestVersion,
            hasMore: page.hasMore,
          })
        } catch (error) {
          const status =
            error instanceof AgoraxManagedAgentHttpError && error.status === 404 ? 404 : 502
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status },
          )
        }
      },
    },
  },
})
