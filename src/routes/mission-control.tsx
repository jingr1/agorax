import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

const searchSchema = z.object({
  tab: z
    .union([z.literal('overview'), z.literal('board'), z.literal('pipeline')])
    .optional(),
  taskId: z.string().optional(),
})

export const Route = createFileRoute('/mission-control')({
  ssr: false,
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/missions',
      search: search.taskId ? { taskId: search.taskId } : {},
      replace: true,
    })
  },
  component: function MissionControlRedirect() {
    return null
  },
})
