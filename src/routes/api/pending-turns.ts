import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { listGlobalPendingTurns } from '../../server/group-chat/pending-turn-service'

/**
 * Global pending-turns list for AttentionToaster bootstrap.
 * Room-scoped routes under /api/rooms/:id/pending-turns remain the
 * primary mutation surface; this is the cross-room read.
 */
export const Route = createFileRoute('/api/pending-turns')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const statusParam = url.searchParams.get('status')
        const status =
          statusParam === 'answered' ||
          statusParam === 'dismissed' ||
          statusParam === 'expired' ||
          statusParam === 'pending'
            ? statusParam
            : 'pending'
        return json({
          ok: true,
          pendingTurns: listGlobalPendingTurns({ status }),
        })
      },
    },
  },
})
