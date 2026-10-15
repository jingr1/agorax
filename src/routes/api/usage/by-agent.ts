import { createFileRoute } from '@tanstack/react-router'
import { usageHandler } from './-handler'
import { getUsageByAgent } from '../../../server/usage/usage-aggregator'

export const Route = createFileRoute('/api/usage/by-agent')({
  server: {
    handlers: {
      GET: async ({ request }) => usageHandler(request, getUsageByAgent),
    },
  },
})
