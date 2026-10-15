import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { resolveRequestProfile } from '../../server/oauth/auth-json-store'
import {
  startCodexLogin,
  pollCodexLogin,
  readOAuthProviderStatus,
  readOAuthProviderError,
} from '../../server/oauth/codex-auth'
import { resolveProfileHermesHome } from '../../server/profiles-browser'

export const Route = createFileRoute('/api/auth/codex')({
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
            const result = await startCodexLogin(profile)
            if (!result.ok) return json(result, { status: 502 })
            return json(result)
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

        if (action === 'poll') {
          const sessionId = String(body.session_id || '').trim()
          const result = pollCodexLogin(sessionId)
          if (!result)
            return json({ error: 'Session not found' }, { status: 404 })
          return json(result)
        }

        if (action === 'status') {
          const profilePath = resolveProfileHermesHome(profile)
          const status = readOAuthProviderStatus(profilePath, 'openai-codex')
          const error = readOAuthProviderError(profilePath, 'openai-codex')
          return json({ status, error: error || null })
        }

        return json({ error: 'Unknown action' }, { status: 400 })
      },
    },
  },
})
