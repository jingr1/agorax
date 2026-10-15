import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { AgoraxManagedAgentHttpClient } from '../../../../../server/agent-runtime/agorax-managed-agent-http-client'
import { isAgoraxManagedAgentBackend } from '../../../../../server/agent-runtime/agorax-managed-agent-bridge'
import { AgoraxManagedRunStore } from '../../../../../server/agent-runtime/agorax-managed-run-store'
import { getAgentRuntimeRouter } from '../../../../../server/agent-runtime/router'

export const Route = createFileRoute('/api/agents/$agentId/activity/$sessionId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ error: 'Unauthorized' }, { status: 401 })
        const agentId = params.agentId.trim()
        const displaySessionId = params.sessionId.trim()
        const declaration = getAgentRuntimeRouter().registry.byId.get(agentId)
        if (!declaration || !isAgoraxManagedAgentBackend(declaration.runtime)) {
          return json({ error: 'Managed Agent is unavailable' }, { status: 404 })
        }
        const runStore = new AgoraxManagedRunStore()
        const displayBinding = await runStore.getByDisplaySession(displaySessionId)
        const binding = displayBinding?.backend === declaration.runtime
          ? displayBinding
          : await runStore.get(displaySessionId)
        const baseUrl = process.env.AGORAX_MANAGED_AGENT_URL?.trim()
        const workspaceId = process.env.AGORAX_WORKSPACE_ID?.trim()
        if (!baseUrl || !workspaceId) {
          return json({ error: 'Managed Agent transport is not configured' }, { status: 503 })
        }
        try {
          const client = new AgoraxManagedAgentHttpClient({ baseUrl, workspaceId })
          const agentSessionId = binding?.backend === declaration.runtime
            ? binding.agentSessionId
            : displaySessionId
          const activity = await client.getActivitySnapshot(agentSessionId)
          if (!binding) {
            await runStore.bind({
              runId: agentSessionId,
              backend: declaration.runtime,
              agentSessionId,
              displaySessionId,
            })
          }
          return json(activity)
        } catch (error) {
          if (!binding) return json({ error: 'Canonical session is unavailable' }, { status: 404 })
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
    },
  },
})
