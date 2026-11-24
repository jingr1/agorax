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
          const reconcileErrors: Array<{ skillId: string; error: string }> = []
          const deployments = listPlatformSkills().flatMap((skill) => {
            try {
              return reconcilePlatformSkill(skill.id)
            } catch (error) {
              reconcileErrors.push({
                skillId: skill.id,
                error: error instanceof Error ? error.message : String(error),
              })
              return []
            }
          })
          return json({ ok: true, ...result, deployments, reconcileErrors })
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
