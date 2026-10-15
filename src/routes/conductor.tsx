import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Conductor was removed. Goal launch lives on Missions
 * (Create Mission → Goal → orchestrator + /api/swarm-dispatch).
 */
export const Route = createFileRoute('/conductor')({
  beforeLoad: () => {
    throw redirect({ to: '/missions' })
  },
})
