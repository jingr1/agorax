import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Legacy /tasks page — redirects to Missions (list entity = Mission).
 */
export const Route = createFileRoute('/tasks')({
  ssr: false,
  beforeLoad: () => {
    throw redirect({
      to: '/missions',
      replace: true,
    })
  },
})
