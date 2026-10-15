import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/skills')({
  ssr: false,
  component: function SkillsLayoutRoute() {
    return <Outlet />
  },
})
