'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

type Props = {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

type Status = 'loading' | 'waiting' | 'approved' | 'expired' | 'error'

export function CodexLoginModal({ open, onClose, onSuccess }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [userCode, setUserCode] = useState('')
  const [verificationUrl, setVerificationUrl] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback(
    (sid: string) => {
      stopPolling()
      const poll = async () => {
        if (closedRef.current) return
        try {
          const res = await fetch('/api/auth/codex', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'poll', session_id: sid }),
          })
          const data = (await res.json()) as {
            status: string
            error: string | null
          }
          if (closedRef.current) return
          if (data.status === 'pending') {
            pollRef.current = setTimeout(poll, 3000)
          } else if (data.status === 'approved') {
            setStatus('approved')
            setTimeout(() => {
              if (!closedRef.current) onSuccess()
            }, 1000)
          } else if (data.status === 'expired') {
            setStatus('expired')
          } else {
            setStatus('error')
            setError(data.error || 'Unknown error')
          }
        } catch {
          if (!closedRef.current) pollRef.current = setTimeout(poll, 3000)
        }
      }
      pollRef.current = setTimeout(poll, 3000)
    },
    [onSuccess, stopPolling],
  )

  const startLogin = useCallback(async () => {
    setStatus('loading')
    setError('')
    setUserCode('')
    setVerificationUrl('')
    try {
      const res = await fetch('/api/auth/codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        session_id?: string
        user_code?: string
        verification_url?: string
        error?: string
      }
      if (!res.ok || !data.ok)
        throw new Error(data.error || 'Could not start Codex login')
      setUserCode(data.user_code || '')
      setVerificationUrl(data.verification_url || '')
      setSessionId(data.session_id || '')
      setStatus('waiting')
      startPolling(data.session_id || '')
      if (data.verification_url) {
        window.open(data.verification_url, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Failed to start')
    }
  }, [startPolling])

  useEffect(() => {
    closedRef.current = false
    if (open) void startLogin()
    return () => {
      closedRef.current = true
      stopPolling()
    }
  }, [open, startLogin, stopPolling])

  if (!open) return null

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(userCode)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="w-full max-w-[420px] rounded-2xl border p-6"
        style={{
          backgroundColor: 'var(--theme-card)',
          borderColor: 'var(--theme-border)',
          color: 'var(--theme-text)',
        }}
      >
        <h3 className="mb-4 text-base font-semibold">OpenAI Codex Login</h3>

        {status === 'loading' ? (
          <div className="flex min-h-[120px] items-center justify-center">
            <span className="text-sm" style={{ color: 'var(--theme-muted)' }}>
              Connecting to OpenAI...
            </span>
          </div>
        ) : status === 'waiting' ? (
          <div className="space-y-4">
            <p
              className="text-center text-sm"
              style={{ color: 'var(--theme-muted)' }}
            >
              Enter the code below on the OpenAI authorization page, then wait
              for approval.
            </p>
            <button
              type="button"
              onClick={() => void copyCode()}
              className="mx-auto flex items-center gap-3 rounded-lg border px-5 py-3 transition-colors hover:border-accent-500"
              style={{
                borderColor: 'var(--theme-border)',
                background: 'var(--theme-bg)',
              }}
            >
              <span className="font-mono text-2xl font-bold tracking-[4px]">
                {userCode}
              </span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
            {verificationUrl ? (
              <Button
                className="w-full"
                onClick={() =>
                  window.open(verificationUrl, '_blank', 'noopener,noreferrer')
                }
              >
                Open OpenAI authorization page
              </Button>
            ) : null}
          </div>
        ) : status === 'approved' ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-3 text-green-500">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <p className="text-sm font-medium">Login successful</p>
          </div>
        ) : status === 'expired' ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-3">
            <p className="text-sm text-red-400">
              Authorization expired. Please try again.
            </p>
            <Button size="sm" onClick={() => void startLogin()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-3">
            <p className="text-center text-sm text-red-400">{error}</p>
            <Button size="sm" onClick={() => void startLogin()}>
              Retry
            </Button>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={status === 'waiting'}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
