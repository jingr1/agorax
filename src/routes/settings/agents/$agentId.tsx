import { createFileRoute, redirect } from '@tanstack/react-router'

/** Legacy deep link — agent settings live on /agents?agent=… */
export const Route = createFileRoute('/settings/agents/$agentId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/agents',
      search: { agent: params.agentId },
    })
  },
})
