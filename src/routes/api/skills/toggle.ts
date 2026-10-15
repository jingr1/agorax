/**
 * Toggle a skill's enabled/disabled state for the active profile.
 * Writes to config.yaml `skills.disabled` directly — no dashboard dependency.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  getActiveProfileName,
  readProfile,
  updateProfileConfig,
} from '../../../server/profiles-browser'

export const Route = createFileRoute('/api/skills/toggle')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const body = (await request.json()) as {
            skillId?: string
            name?: string
            enabled?: boolean
            profile?: string
          }
          const name = (body.name || body.skillId || '').trim()
          if (!name) {
            return json(
              { ok: false, error: 'name or skillId required' },
              { status: 400 },
            )
          }
          if (typeof body.enabled !== 'boolean') {
            return json(
              { ok: false, error: 'enabled (boolean) required' },
              { status: 400 },
            )
          }

          const profile =
            body.profile?.trim() || getActiveProfileName() || 'default'
          const detail = readProfile(profile)
          const currentDisabled: string[] = Array.isArray(
            (detail.config as any)?.skills?.disabled,
          )
            ? ((detail.config as any).skills.disabled as string[])
            : []

          let nextDisabled: string[]
          if (body.enabled) {
            nextDisabled = currentDisabled.filter((s) => s !== name)
          } else {
            nextDisabled = currentDisabled.includes(name)
              ? currentDisabled
              : [...currentDisabled, name]
          }

          updateProfileConfig(profile, {
            skills: { disabled: nextDisabled },
          })

          return json({
            ok: true,
            name,
            enabled: body.enabled,
            disabled: nextDisabled,
          })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to toggle skill',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
