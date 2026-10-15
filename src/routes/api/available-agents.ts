import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { getAgentRuntimeRouter } from '../../server/agent-runtime/router'

export const Route = createFileRoute('/api/available-agents')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const router = getAgentRuntimeRouter()
        const agents = router.registry.agents.map((a) => ({
          id: a.id,
          runtime: a.runtime,
          profile: a.profile ?? null,
          displayName: a.displayName || a.id,
          mentionName: a.mentionName || a.id,
          capabilities: a.capabilities,
        }))
        return json({ ok: true, agents })
      },
    },
  },
})
