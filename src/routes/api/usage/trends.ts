import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { usageHandler } from './-handler'
import { getUsageTrends } from '../../../server/usage/usage-aggregator'
import type { UsageFilters } from '../../../server/usage/usage-types'

export const Route = createFileRoute('/api/usage/trends')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return usageHandler(request, (filters: UsageFilters) =>
          getUsageTrends(filters),
        )
      },
    },
  },
})
