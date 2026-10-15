import { createFileRoute } from '@tanstack/react-router'
import { usageHandler } from './-handler'
import { getUsageByModel } from '../../../server/usage/usage-aggregator'

export const Route = createFileRoute('/api/usage/by-model')({
  server: {
    handlers: {
      GET: async ({ request }) => usageHandler(request, getUsageByModel),
    },
  },
})
