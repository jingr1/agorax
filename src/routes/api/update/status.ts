import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { readUpdateStatus } from '../../../server/update-system'

/**
 * GET /api/update/status — **the** product update-check endpoint.
 * Daily / banner / Runtimes「检查更新」all share this. Default is TTL-gated
 * `git fetch` (`auto`); `?refresh=1` forces a live fetch.
 */
export const Route = createFileRoute('/api/update/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const refresh =
          new URL(request.url).searchParams.get('refresh') === '1'
        return json(
          readUpdateStatus({ fetch: refresh ? 'force' : 'auto' }),
        )
      },
    },
  },
})
