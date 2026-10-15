import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { loadProjectsFile } from '../../server/task-pipeline/projects'

/**
 * GET /api/projects → declared projects from projects.yaml
 */
export const Route = createFileRoute('/api/projects')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        try {
          const file = loadProjectsFile()
          return json({
            projects: file.projects.map((p) => ({
              id: p.id,
              repo: p.repo,
              defaultBranch: p.defaultBranch,
              selfHosted: p.selfHosted,
            })),
          })
        } catch (error) {
          return json(
            {
              error: error instanceof Error ? error.message : String(error),
              projects: [],
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
