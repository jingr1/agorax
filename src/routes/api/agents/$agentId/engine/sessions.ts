import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from '../../../../../server/agent-runtime/agorax-managed-agent-bridge'
import { getAgentRuntimeRouter } from '../../../../../server/agent-runtime/router'
import { managedAgentTargetIdForRuntime } from '@/lib/managed-agent-runtime/agent-targets'

export const Route = createFileRoute('/api/agents/$agentId/engine/sessions')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const agentId = params.agentId.trim()
        const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
        if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
          return json({ error: 'Managed Agent is unavailable' }, { status: 404 })
        }
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!baseUrl || !workspaceId) {
          return json({ error: 'Managed Agent transport is not configured' }, { status: 503 })
        }
        try {
          const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
          const targetId = managedAgentTargetIdForRuntime(
            declaration.runtime,
            agentId,
          )
          // Agorax-style: only surface sessions owned by this agent's target.
          const sessions = await client.listSessions({ agentTargetId: targetId })
          const cursors = Object.fromEntries(
            sessions.map((session) => [session.agentSessionId, session.messageVersion]),
          )
          return json({ sessions, cursors })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
    },
  },
})
