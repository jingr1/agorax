import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { loadPipelineTemplates } from '../../server/task-pipeline/pipeline-templates'

export const Route = createFileRoute('/api/pipelines')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        try {
          const file = loadPipelineTemplates()
          const pipelines = file.pipelines.map((p) => ({
            id: p.id,
            name: p.name,
            stages: p.stages.length,
          }))
          return json({ pipelines })
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      },
    },
  },
})
