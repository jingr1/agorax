import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../../../../server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
  AgoraxManagedAgentHttpError,
} from '../../../../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'

function managedClient() {
  const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
  const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
  if (!baseUrl || !workspaceId) return null
  return new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
}

export const Route = createFileRoute(
  '/api/agents/$agentId/engine/session/$sessionId/turns/$turnId/plan-decisions/$requestId',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const body = (await request.json().catch(() => null)) as {
          promptKind?: string
          action?: string
          idempotencyKey?: string
        } | null
        const promptKind =
          typeof body?.promptKind === 'string' ? body.promptKind.trim() : ''
        const action = typeof body?.action === 'string' ? body.action.trim() : ''
        const idempotencyKey =
          typeof body?.idempotencyKey === 'string'
            ? body.idempotencyKey.trim()
            : ''
        if (!promptKind || !action || !idempotencyKey) {
          return json(
            { error: 'promptKind, action, and idempotencyKey are required' },
            { status: 400 },
          )
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
          const result = await client.submitPlanDecision({
            agentSessionId: identity.agentSessionId,
            turnId: params.turnId,
            requestId: params.requestId,
            promptKind,
            action,
            idempotencyKey,
          })
          return json({
            result,
            activity: await client.getActivitySnapshot(identity.agentSessionId),
          })
        } catch (error) {
          const status =
            error instanceof AgoraxManagedAgentHttpError
              ? error.status >= 400 && error.status < 500
                ? error.status
                : 502
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
