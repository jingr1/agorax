import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { requireJsonContentType } from '../../../../../server/rate-limit'
import {
  materializeHermesAgentSkills,
  removeAgentSkill,
  setAgentSkillEnabled,
} from '../../../../../server/platform-skills'

export const Route = createFileRoute(
  '/api/agents/$agentId/skills/$skillId',
)({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        const skillId =
          typeof params.skillId === 'string' ? params.skillId : ''
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >
        if (typeof body.enabled !== 'boolean') {
          return json({ error: 'enabled boolean is required' }, { status: 400 })
        }
        const binding = setAgentSkillEnabled(agentId, skillId, body.enabled)
        if (!binding) {
          return json({ error: 'Binding not found' }, { status: 404 })
        }
        materializeHermesAgentSkills(agentId)
        return json({ skill: binding })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const agentId =
          typeof params.agentId === 'string' ? params.agentId : ''
        const skillId =
          typeof params.skillId === 'string' ? params.skillId : ''
        const ok = removeAgentSkill(agentId, skillId)
        if (!ok) {
          return json({ error: 'Binding not found' }, { status: 404 })
        }
        materializeHermesAgentSkills(agentId)
        return json({ ok: true })
      },
    },
  },
})
