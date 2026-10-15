import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { listRooms } from '@/lib/group-chat-api'
import { resolveRoomToOpen } from '@/screens/group-chat/last-room'

export const Route = createFileRoute('/group-chat/')({
  component: GroupChatIndex,
})

/**
 * Landing route for /group-chat. Restores the last open room once;
 * does not live in the layout (layout redirects trapped other app pages).
 */
function GroupChatIndex() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'loading' | 'empty'>('loading')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await listRooms()
        if (cancelled) return
        const target = resolveRoomToOpen(res.rooms)
        if (target) {
          navigate({
            to: '/group-chat/$roomId',
            params: { roomId: target },
            replace: true,
          })
          return
        }
        setStatus('empty')
      } catch {
        if (!cancelled) setStatus('empty')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])

  return (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      {status === 'loading'
        ? 'Opening last room…'
        : 'No room yet — create one from the sidebar.'}
    </div>
  )
}
