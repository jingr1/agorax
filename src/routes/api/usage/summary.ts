import { createFileRoute } from '@tanstack/react-router'
import { usageHandler } from './-handler'
import { getUsageSummary } from '../../../server/usage/usage-aggregator'

export const Route = createFileRoute('/api/usage/summary')({
  server: {
    handlers: {
      GET: async ({ request }) => usageHandler(request, getUsageSummary),
    },
  },
})
