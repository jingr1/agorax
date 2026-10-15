import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../../server/auth-middleware'
import { listComposerSkillsForAgent } from '../../../../../server/platform-skills'

export const Route = createFileRoute(
  '/api/agents/$agentId/skills/composer',
)({
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
        const url = new URL(request.url)
        const includeContent = url.searchParams.get('includeContent') === '1'
        return json({
          agentId,
          skills: listComposerSkillsForAgent(agentId, { includeContent }),
        })
      },
    },
  },
})
