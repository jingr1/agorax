import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/profiles')({
  ssr: false,
  beforeLoad: () => {
    throw redirect({
      to: '/agents',
      replace: true,
    })
  },
  component: function ProfilesRedirect() {
    return null
  },
})
