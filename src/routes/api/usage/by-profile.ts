import { createFileRoute } from '@tanstack/react-router'
import { usageHandler } from './-handler'
import { getUsageByProfile } from '../../../server/usage/usage-aggregator'

export const Route = createFileRoute('/api/usage/by-profile')({
  server: {
    handlers: {
      GET: async ({ request }) => usageHandler(request, getUsageByProfile),
    },
  },
})
