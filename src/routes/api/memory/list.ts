import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  listMemoryAgents,
  listMemoryFiles,
  normalizeMemoryAgentId,
  resolveMemoryAgentScope,
} from '../../../server/memory-browser'

export const Route = createFileRoute('/api/memory/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        try {
          const agentId = normalizeMemoryAgentId(url.searchParams.get('agent'))
          const agents = listMemoryAgents()
          const scope =
            agents.find((agent) => agent.id === agentId) ??
            resolveMemoryAgentScope(agentId)
          return json({
            agentId: scope.id,
            memoryKind: scope.memoryKind,
            runtime: scope.runtime,
            rootHint: scope.rootHint,
            writable: scope.writable,
            agents,
            files: listMemoryFiles(agentId),
          })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to list memory files',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
