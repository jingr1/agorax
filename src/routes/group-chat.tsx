import { createFileRoute, Outlet } from '@tanstack/react-router'
import { GroupChatLayout } from '@/screens/group-chat/group-chat-layout'

export const Route = createFileRoute('/group-chat')({
  component: GroupChatLayout,
})
