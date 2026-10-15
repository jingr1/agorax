import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { requireJsonContentType } from '../../../../server/rate-limit'
import {
  addAgentSkills,
  listAgentSkillBindings,
  materializeHermesAgentSkills,
  setAgentSkills,
} from '../../../../server/platform-skills'
import { getAgentRuntimeRouter } from '../../../../server/agent-runtime/router'

function agentExists(agentId: string): boolean {
  const router = getAgentRuntimeRouter()
  return (
    router.registry.byId.has(agentId) ||
    router.registry.orphanProfiles.includes(agentId)
  )
}

function parseSkillIds(body: Record<string, unknown>): Array<string> {
  if (Array.isArray(body.skillIds)) {
    return body.skillIds
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean)
  }
  if (typeof body.skill_ids === 'string') {
    return body.skill_ids
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  }
  return []
}

export const Route = createFileRoute('/api/agents/$agentId/skills')({
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
        return json({
          agentId,
          skills: listAgentSkillBindings(agentId),
        })
      },
      PUT: async ({ request, params }) => {
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
        try {
          const skills = setAgentSkills(agentId, parseSkillIds(body))
          materializeHermesAgentSkills(agentId)
          return json({ agentId, skills })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to set skills'
          return json(
            { error: message },
            { status: message.includes('not found') ? 404 : 400 },
          )
        }
      },
      POST: async ({ request, params }) => {
        // Additive bind (same as /skills/add) — keep POST on collection for
        // clients that POST skillIds without a dedicated /add path.
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
        try {
          const skills = addAgentSkills(agentId, parseSkillIds(body))
          materializeHermesAgentSkills(agentId)
          return json({ agentId, skills })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to add skills'
          return json(
            { error: message },
            { status: message.includes('not found') ? 404 : 400 },
          )
        }
      },
    },
  },
})
