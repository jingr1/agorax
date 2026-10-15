/**
 * Toggle a skill's enabled/disabled state for a specific profile.
 *
 *   PUT /api/profiles/toggle-skill
 *     body: { profile: string, name: string, enabled: boolean }
 *
 * Writes `skills.disabled` in the target profile's config.yaml directly,
 * without proxying through the dashboard (:9119).
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  readProfile,
  updateProfileConfig,
} from '../../../server/profiles-browser'

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const Route = createFileRoute('/api/profiles/toggle-skill')({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as {
            profile?: string
            name?: string
            enabled?: boolean
          }
          const profile = (body.profile || '').trim()
          const name = (body.name || '').trim()
          const enabled = Boolean(body.enabled)
          if (!profile || !PROFILE_NAME_RE.test(profile)) {
            return json(
              { ok: false, error: 'A valid profile name is required' },
              { status: 400 },
            )
          }
          if (!name) {
            return json(
              { ok: false, error: 'A skill name is required' },
              { status: 400 },
            )
          }

          let detail
          try {
            detail = readProfile(profile)
          } catch {
            return json(
              { ok: false, error: `Profile "${profile}" not found` },
              { status: 404 },
            )
          }

          const currentDisabled: string[] = Array.isArray(
            (detail.config as any)?.skills?.disabled,
          )
            ? ((detail.config as any).skills.disabled as string[])
            : []

          let nextDisabled: string[]
          if (enabled) {
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
            enabled,
            disabled: nextDisabled,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
