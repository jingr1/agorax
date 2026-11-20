import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { seedPlatformSkillsFromDisk } from '../../../server/platform-skills'
import { listPlatformSkills } from '../../../server/platform-skills/store'
import { reconcilePlatformSkill } from '../../../server/platform-skills/reconcile'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/platform-skills/seed')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const ct = requireJsonContentType(request)
        if (ct) return ct
        try {
          const result = seedPlatformSkillsFromDisk({ materialize: false })
          const deployments = listPlatformSkills().flatMap((skill) =>
            reconcilePlatformSkill(skill.id),
          )
          return json({ ok: true, ...result, deployments })
        } catch (error) {
          return json(
            {
              error: error instanceof Error ? error.message : 'Seed failed',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
