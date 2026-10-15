import { createFileRoute } from '@tanstack/react-router'
import { RoomsScreen } from '@/screens/group-chat/rooms-screen'

export const Route = createFileRoute('/group-chat/$roomId')({
  component: RoomsScreen,
})
