'use client'

/**
 * Global AttentionToaster — P5 human gate cards (bottom-right).
 * Bootstrap from GET /api/pending-turns; live updates via collab-events SSE.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PendingTurn } from '@/lib/group-chat-types'

type AttentionTurn = PendingTurn & { missionId?: string | null }

async function fetchPending(): Promise<Array<AttentionTurn>> {
  try {
    const res = await fetch('/api/pending-turns?status=pending')
    if (!res.ok) return []
    const data = (await res.json()) as {
      ok?: boolean
      pendingTurns?: Array<AttentionTurn>
    }
    return Array.isArray(data.pendingTurns) ? data.pendingTurns : []
  } catch {
    return []
  }
}

async function answerTurn(
  turnId: string,
  body: { answerText?: string; optionId?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`/api/pending-turns/${turnId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

async function dismissTurn(turnId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/pending-turns/${turnId}/dismiss`, {
      method: 'POST',
    })
    return res.ok
  } catch {
    return false
  }
}

export function AttentionToaster() {
  const [turns, setTurns] = useState<Array<AttentionTurn>>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    void fetchPending().then(setTurns)
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/collab-events?scope=global')

    const onAttention = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as {
        pendingTurnId?: string
        roomId?: string
        kind?: string
        reason?: string
        assignmentId?: string
        taskId?: string
        missionId?: string
      }
      if (!data.pendingTurnId || !data.roomId) return
      setTurns((prev) => {
        if (prev.some((t) => t.id === data.pendingTurnId)) return prev
        const next: AttentionTurn = {
          id: data.pendingTurnId!,
          roomId: data.roomId!,
          taskId: data.taskId ?? null,
          assignmentId: data.assignmentId ?? null,
          requestedBy: 'agent',
          targetParticipantId: null,
          messageId: null,
          kind: (data.kind as AttentionTurn['kind']) || 'needs_input',
          reason: data.reason ?? null,
          options: null,
          status: 'pending',
          createdAt: Date.now(),
          answeredAt: null,
          answeredMessageId: null,
          missionId: data.missionId ?? null,
        }
        return [...prev, next]
      })
      // Refresh full payload (options etc.) from API.
      void fetchPending().then(setTurns)
    }

    const onResolved = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { turnId?: string; pendingTurnId?: string }
      const id = data.turnId || data.pendingTurnId
      if (!id) return
      setTurns((prev) => prev.filter((t) => t.id !== id))
    }

    es.addEventListener('group_chat_human_attention', onAttention)
    es.addEventListener('group_chat_human_answered', onResolved)
    es.addEventListener('group_chat_human_dismissed', onResolved)

    return () => {
      es.close()
    }
  }, [])

  const handleAnswer = useCallback(
    async (turnId: string, body: { answerText?: string; optionId?: string }) => {
      const ok = await answerTurn(turnId, body)
      if (ok) setTurns((prev) => prev.filter((t) => t.id !== turnId))
    },
    [],
  )

  const handleDismiss = useCallback(async (turnId: string) => {
    const ok = await dismissTurn(turnId)
    if (ok) setTurns((prev) => prev.filter((t) => t.id !== turnId))
  }, [])

  if (!mounted || turns.length === 0) return null

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[9998] flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
      aria-live="polite"
    >
      {turns.slice(0, 5).map((turn) => (
        <div
          key={turn.id}
          className={cn(
            'pointer-events-auto rounded-xl border p-3 shadow-lg backdrop-blur-sm',
          )}
          style={{
            background: 'var(--theme-card, #fff)',
            borderColor: 'var(--theme-border, #e5e7eb)',
            color: 'var(--theme-text, #111)',
          }}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide opacity-70">
              {turn.kind}
            </span>
            <button
              type="button"
              className="rounded p-0.5 text-xs opacity-60 hover:opacity-100"
              onClick={() => void handleDismiss(turn.id)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          <p className="mb-2 line-clamp-4 text-sm">
            {turn.reason || 'Needs human input'}
          </p>
          {turn.options && turn.options.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {turn.options.map((opt) => (
                <Button
                  key={opt.id}
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void handleAnswer(turn.id, { optionId: opt.id })
                  }
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Link
              to="/group-chat/$roomId"
              params={{ roomId: turn.roomId }}
              className="text-xs font-medium underline opacity-80 hover:opacity-100"
            >
              打开房间
            </Link>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleDismiss(turn.id)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  )
}
