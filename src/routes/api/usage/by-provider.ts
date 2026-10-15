import { createFileRoute } from '@tanstack/react-router'
import { usageHandler } from './-handler'
import { getUsageByProvider } from '../../../server/usage/usage-aggregator'

export const Route = createFileRoute('/api/usage/by-provider')({
  server: {
    handlers: {
      GET: async ({ request }) => usageHandler(request, getUsageByProvider),
    },
  },
})
