import { useState } from 'react'
import { countRoomAgentProviderSiblings } from '../lib/avatar-utils'
import { MemberAvatar } from './member-avatar'
import type { PendingTurn, RoomParticipant } from '@/lib/group-chat-types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type PendingTurnCardProps = {
  turn: PendingTurn
  participants: Array<RoomParticipant>
  onAnswer: (turnId: string, text: string) => Promise<void>
  onDismiss: (turnId: string) => Promise<void>
}

export function PendingTurnCard({
  turn,
  participants,
  onAnswer,
  onDismiss,
}: PendingTurnCardProps) {
  const [answer, setAnswer] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const requester = participants.find(
    (p) => p.participantId === turn.requestedBy,
  )

  return (
    <div
      className="mb-3 rounded-xl border p-3 shadow-sm"
      style={{
        background: 'var(--theme-card)',
        borderColor: 'var(--theme-border)',
        color: 'var(--theme-text)',
      }}
    >
      <div className="flex items-start gap-3">
        <MemberAvatar
          id={turn.requestedBy}
          name={requester?.displayName ?? turn.requestedBy}
          kind={requester?.kind ?? 'agent'}
          status="thinking"
          size={36}
          runtime={requester?.runtime}
          providerSiblingCount={countRoomAgentProviderSiblings(
            participants,
            requester?.runtime,
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium">
              {requester?.displayName ?? turn.requestedBy}
            </span>
            <Badge variant={turn.kind === 'approval' ? 'warning' : 'default'}>
              {turn.kind}
            </Badge>
          </div>
          <div className="text-sm opacity-90 mb-2">
            {turn.reason || 'Needs human input'}
          </div>

          {turn.options && turn.options.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {turn.options.map((opt) => (
                <Button
                  key={opt.id}
                  size="sm"
                  variant="secondary"
                  disabled={isSubmitting}
                  onClick={async () => {
                    if (isSubmitting) return
                    setIsSubmitting(true)
                    try {
                      await onAnswer(turn.id, opt.replyText)
                    } finally {
                      setIsSubmitting(false)
                    }
                  }}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              size="sm"
              placeholder="Reply..."
              value={answer}
              disabled={isSubmitting}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && answer.trim() && !isSubmitting) {
                  setIsSubmitting(true)
                  try {
                    await onAnswer(turn.id, answer.trim())
                  } finally {
                    setIsSubmitting(false)
                  }
                }
              }}
              className="flex-1"
            />
            <Button
              size="sm"
              disabled={isSubmitting || !answer.trim()}
              onClick={async () => {
                if (isSubmitting || !answer.trim()) return
                setIsSubmitting(true)
                try {
                  await onAnswer(turn.id, answer.trim())
                } finally {
                  setIsSubmitting(false)
                }
              }}
            >
              {isSubmitting ? '…' : 'Answer'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isSubmitting}
              onClick={async () => {
                if (isSubmitting) return
                setIsSubmitting(true)
                try {
                  await onDismiss(turn.id)
                } finally {
                  setIsSubmitting(false)
                }
              }}
            >
              {isSubmitting ? '…' : 'Dismiss'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
