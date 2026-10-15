import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { getPendingTurn } from '../../../../server/group-chat/room-store'
import { answerPendingTurnWithMessage } from '../../../../server/group-chat/pending-turn-service'

export const Route = createFileRoute('/api/pending-turns/$turnId/answer')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const turn = getPendingTurn(params.turnId)
        if (!turn) {
          return json({ ok: false, error: 'Not found' }, { status: 404 })
        }
        let body: { answerText?: string; optionId?: string } = {}
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }

        let answerText = typeof body.answerText === 'string' ? body.answerText : ''
        if (!answerText && body.optionId && turn.options) {
          const opt = turn.options.find((o) => o.id === body.optionId)
          answerText = opt?.replyText ?? opt?.label ?? ''
        }
        if (!answerText.trim()) {
          return json(
            { ok: false, error: 'answerText or optionId required' },
            { status: 400 },
          )
        }

        const result = await answerPendingTurnWithMessage({
          roomId: turn.roomId,
          turnId: turn.id,
          answerText: answerText.trim(),
        })
        if (!result) {
          return json({ ok: false, error: 'Failed to answer' }, { status: 400 })
        }
        return json({ ok: true, turn: result.turn, message: result.message })
      },
    },
  },
})
