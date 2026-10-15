import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import {
  createSessionForAgent,
  listSessionsForAgent,
} from '../../../../server/agent-sessions-service'

/**
 * GET/POST /api/agents/:agentId/sessions
 *
 * Same layout as /api/rooms: collection handlers live on this file;
 * /sessions/$sessionId is a child. Do not add sessions/index.ts — that
 * steals the bare /sessions URL and leaves GET broken.
 */
export const Route = createFileRoute('/api/agents/$agentId/sessions')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        try {
          const sessions = await listSessionsForAgent(agentId)
          return json({ sessions, agentId })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId = typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const title =
          typeof body.title === 'string' ? body.title.trim() : undefined
        const model =
          typeof body.model === 'string' ? body.model.trim() : undefined
        const created = createSessionForAgent(agentId, { title, model })
        return json({ sessionId: created.sessionId, agentId, title, model })
      },
    },
  },
})
