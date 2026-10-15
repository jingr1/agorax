import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { resolveRequestProfile } from '../../server/oauth/auth-json-store'
import {
  startAnthropicLogin,
  submitAnthropicCode,
  getAnthropicSessionStatus,
  readOAuthProviderStatus,
  readOAuthProviderError,
} from '../../server/oauth/anthropic-auth'
import { resolveProfileHermesHome } from '../../server/profiles-browser'

export const Route = createFileRoute('/api/auth/anthropic')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ error: 'Unauthorized' }, { status: 401 })
        let body: Record<string, unknown> = {}
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          /* empty */
        }
        const action = String(body.action || '').trim()
        const profile =
          String(body.profile || '').trim() || resolveRequestProfile(request)

        if (action === 'start') {
          try {
            const result = startAnthropicLogin(profile)
            return json({ ok: true, ...result })
          } catch (err) {
            return json(
              {
                ok: false,
                error: err instanceof Error ? err.message : 'Failed to start',
              },
              { status: 500 },
            )
          }
        }

        if (action === 'submit') {
          const sessionId = String(body.session_id || '').trim()
          const code = String(body.code || '').trim()
          if (!sessionId || !code)
            return json(
              { error: 'session_id and code are required' },
              { status: 400 },
            )
          try {
            const result = await submitAnthropicCode(sessionId, code)
            return json(result)
          } catch (err) {
            return json(
              {
                status: 'error',
                error: err instanceof Error ? err.message : 'Submit failed',
              },
              { status: 502 },
            )
          }
        }

        if (action === 'poll') {
          const sessionId = String(body.session_id || '').trim()
          const result = getAnthropicSessionStatus(sessionId)
          if (!result)
            return json({ error: 'Session not found' }, { status: 404 })
          return json(result)
        }

        if (action === 'status') {
          const profilePath = resolveProfileHermesHome(profile)
          const statusClaude = readOAuthProviderStatus(
            profilePath,
            'claude-oauth',
          )
          const error = readOAuthProviderError(profilePath, 'claude-oauth')
          return json({ status: statusClaude, error: error || null })
        }

        return json({ error: 'Unknown action' }, { status: 400 })
      },
    },
  },
})
