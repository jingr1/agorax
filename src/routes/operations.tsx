import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/operations')({
  ssr: false,
  beforeLoad: () => {
    throw redirect({
      to: '/agents',
      replace: true,
    })
  },
  component: function OperationsRedirect() {
    return null
  },
})
