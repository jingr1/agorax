import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from '../../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'

function managedClient() {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

export const Route = createFileRoute(
  '/api/agents/$agentId/engine/session/$sessionId',
)({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const client = managedClient()
        if (!client) {
          return json({ error: 'Managed Agent daemon is not configured' }, { status: 503 })
        }
        const identity = await resolveAgoraxManagedSessionIdentity({
          agentId: params.agentId,
          sessionId: params.sessionId,
        })
        if (!identity.ok) return json({ error: identity.error }, { status: identity.status })
        try {
          const result = await client.deleteSession(identity.agentSessionId)
          return json({ result })
        } catch (error) {
          const status =
            error instanceof AgoraxManagedAgentHttpError && error.status === 404
              ? 404
              : 502
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status },
          )
        }
      },
    },
  },
})
