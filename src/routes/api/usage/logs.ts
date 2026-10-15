import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { parseUsageFilters } from '../../../server/usage/filter-params'
import { getRequestLogs } from '../../../server/usage/usage-aggregator'

export const Route = createFileRoute('/api/usage/logs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const filters = parseUsageFilters(url.searchParams)
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
        const pageSize = Math.min(
          500,
          Math.max(10, Number(url.searchParams.get('pageSize') ?? 50)),
        )
        try {
          const result = await getRequestLogs(filters, page, pageSize)
          return json({ ok: true, data: result })
        } catch (err) {
          console.error('[usage/logs] error:', err)
          return json({ ok: false, error: String(err) }, { status: 500 })
        }
      },
    },
  },
})
