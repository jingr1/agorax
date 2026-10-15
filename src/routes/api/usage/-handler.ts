import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { parseUsageFilters } from '../../../server/usage/filter-params'
import type { UsageFilters } from '../../../server/usage/usage-types'

export async function usageHandler(
  request: Request,
  handler: (filters: UsageFilters) => Promise<unknown>,
) {
  if (!isAuthenticated(request)) {
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const filters = parseUsageFilters(url.searchParams)
  try {
    const data = await handler(filters)
    return json({ ok: true, data })
  } catch (err) {
    console.error('[usage] handler error:', err)
    return json({ ok: false, error: String(err) }, { status: 500 })
  }
}