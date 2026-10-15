import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { requireJsonContentType } from '../../../../server/rate-limit'
import {
  listAgentLocalSkills,
  promoteAgentLocalSkills,
} from '../../../../server/platform-skills'
import { getAgentRuntimeRouter } from '../../../../server/agent-runtime/router'

function agentExists(agentId: string): boolean {
  const router = getAgentRuntimeRouter()
  return (
    router.registry.byId.has(agentId) ||
    router.registry.orphanProfiles.includes(agentId)
  )
}

export const Route = createFileRoute('/api/agents/$agentId/local-skills')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        if (!agentExists(agentId)) {
          return json({ error: `Unknown agent: ${agentId}` }, { status: 404 })
        }
        return json(listAgentLocalSkills(agentId))
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        if (!agentId) {
          return json({ error: 'agentId is required' }, { status: 400 })
        }
        if (!agentExists(agentId)) {
          return json({ error: `Unknown agent: ${agentId}` }, { status: 404 })
        }
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        const skillNames = Array.isArray(body.skillNames)
          ? body.skillNames
              .map((n) => (typeof n === 'string' ? n.trim() : ''))
              .filter(Boolean)
          : typeof body.skillName === 'string'
            ? [body.skillName.trim()].filter(Boolean)
            : []
        try {
          const result = promoteAgentLocalSkills(agentId, skillNames)
          return json({ agentId, ...result }, { status: 201 })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Promote failed'
          return json({ error: message }, { status: 400 })
        }
      },
    },
  },
})
