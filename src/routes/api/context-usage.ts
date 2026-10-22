import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '@/server/auth-middleware'
import { readContextUsage } from '@/server/context-usage'

export const Route = createFileRoute('/api/context-usage')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const url = new URL(request.url)
        const sessionId =
          url.searchParams.get('sessionId')?.trim() ||
          url.searchParams.get('sessionKey')?.trim() ||
          ''
        const model = url.searchParams.get('model')?.trim() || ''
        const profile =
          url.searchParams.get('profile')?.trim() ||
          url.searchParams.get('agent')?.trim() ||
          ''

        const snapshot = await readContextUsage(sessionId, { model, profile })
        return json(snapshot)
      },
    },
  },
})
