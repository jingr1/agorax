import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { seedPlatformSkillsFromDisk } from '../../../server/platform-skills'

export const Route = createFileRoute('/api/platform-skills/seed')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const result = seedPlatformSkillsFromDisk({ materialize: false })
          return json({ ok: true, ...result })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error ? error.message : 'Seed failed',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
