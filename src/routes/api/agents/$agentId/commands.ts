import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { buildAgentCommands } from '../../../../server/agent-commands'

export const Route = createFileRoute('/api/agents/$agentId/commands')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() || undefined
          return json(await buildAgentCommands(params.agentId, sessionId, request.signal))
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
        }
      },
    },
  },
})
