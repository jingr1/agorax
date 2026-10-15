import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from '../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'

export const Route = createFileRoute('/api/agents/$agentId/engine/session/$sessionId/detail')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!baseUrl || !workspaceId) {
          return json({ error: 'Managed Agent transport is not configured' }, { status: 503 })
        }
        const identity = await resolveAgoraxManagedSessionIdentity({
          agentId: params.agentId,
          sessionId: params.sessionId,
        })
        if (!identity.ok) return json({ error: identity.error }, { status: identity.status })
        try {
          const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
          const detail = await client.getSessionDetail(identity.agentSessionId)
          return json({ detail })
        } catch (error) {
          // A daemon 404 means the canonical session is gone (stale binding or
          // pruned daemon db) — surface it as 404 so the client can fall back
          // to re-activation instead of a misleading gateway error.
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
