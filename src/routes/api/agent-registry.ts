import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  createAgentDeclaration,
  deleteAgentDeclaration,
  listAgentDeclarations,
  updateAgentDeclaration,
} from '../../server/agent-registry'

function errorResponse(error: unknown) {
  return json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status: 400 },
  )
}

export const Route = createFileRoute('/api/agent-registry')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false }, { status: 401 })
        return json({ ok: true, agents: listAgentDeclarations() })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false }, { status: 401 })
        try {
          return json({ ok: true, roster: createAgentDeclaration(await request.json()) })
        } catch (error) {
          return errorResponse(error)
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false }, { status: 401 })
        try {
          const body = (await request.json()) as { agentId?: string; patch?: Record<string, unknown> }
          if (!body.agentId || !body.patch) throw new Error('agentId and patch are required')
          return json({ ok: true, roster: updateAgentDeclaration(body.agentId, body.patch) })
        } catch (error) {
          return errorResponse(error)
        }
      },
      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false }, { status: 401 })
        try {
          const body = (await request.json()) as { agentId?: string }
          if (!body.agentId) throw new Error('agentId is required')
          return json({ ok: true, roster: deleteAgentDeclaration(body.agentId) })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})