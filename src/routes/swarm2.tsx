import { createFileRoute, redirect } from '@tanstack/react-router'

/** Legacy alias — keep one release for bookmarks, then remove. */
export const Route = createFileRoute('/swarm2')({
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: '/swarm', replace: true })
  },
})
