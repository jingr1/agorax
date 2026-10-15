import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../../../server/auth-middleware'
import {
  AgoraxManagedAgentHttpClient,
} from '../../../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { resolveAgoraxManagedSessionIdentity } from '../../../../../../../server/agent-runtime/agorax-managed-agent-session-identity'
import type { ManagedAgentInteractionResponseDto } from '@/lib/managed-agent-runtime/command-dtos'

export const Route = createFileRoute(
  '/api/agents/$agentId/interactions/$sessionId/$turnId/$requestId',
)({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = params.agentId.trim()
        const sessionId = params.sessionId.trim()
        const turnId = params.turnId.trim()
        const requestId = params.requestId.trim()
        if (!agentId || !sessionId || !turnId || !requestId) {
          return json(
            { ok: false, error: 'agent, session, turn, and request ids are required' },
            { status: 400 },
          )
        }

        const identity = await resolveAgoraxManagedSessionIdentity({
          agentId,
          sessionId,
        })
        if (!identity.ok) {
          return json({ ok: false, error: identity.error }, { status: identity.status })
        }
        const agentSessionId = identity.agentSessionId
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!baseUrl || !workspaceId) {
          return json({ ok: false, error: 'Managed Agent transport is not configured' }, { status: 503 })
        }

        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
        const action = typeof body.action === 'string' ? body.action.trim() : ''
        const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : ''
        const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
          ? body.payload as Record<string, unknown>
          : undefined
        if (!action && !optionId && !payload) {
          return json({ ok: false, error: 'an interaction response is required' }, { status: 400 })
        }

        try {
          const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
          const result = await client.respondToInteraction({ agentSessionId, turnId, requestId, ...(action ? { action } : {}), ...(optionId ? { optionId } : {}), ...(payload ? { payload } : {}) })
          const response: ManagedAgentInteractionResponseDto = {
            result,
            activity: await client.getActivitySnapshot(agentSessionId),
          }
          return json({ ok: true, ...response })
        } catch (error) {
          return json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
    },
  },
})