'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

type Props = {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

type Status =
  | 'loading'
  | 'waiting'
  | 'submitting'
  | 'approved'
  | 'expired'
  | 'error'

export function AnthropicLoginModal({ open, onClose, onSuccess }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [authUrl, setAuthUrl] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const closedRef = useRef(false)

  const startLogin = useCallback(async () => {
    setStatus('loading')
    setError('')
    setAuthUrl('')
    setSessionId('')
    setCode('')
    try {
      const res = await fetch('/api/auth/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        session_id?: string
        authorization_url?: string
        error?: string
      }
      if (!res.ok || !data.ok)
        throw new Error(data.error || 'Could not start Claude login')
      setAuthUrl(data.authorization_url || '')
      setSessionId(data.session_id || '')
      setStatus('waiting')
      if (data.authorization_url) {
        window.open(data.authorization_url, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Failed to start')
    }
  }, [])

  const submitCode = useCallback(async () => {
    if (!sessionId || !code.trim()) return
    setStatus('submitting')
    setError('')
    try {
      const res = await fetch('/api/auth/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          session_id: sessionId,
          code: code.trim(),
        }),
      })
      const data = (await res.json()) as {
        status: string
        error: string | null
      }
      if (closedRef.current) return
      if (data.status === 'approved') {
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
    } catch (err) {
      if (closedRef.current) return
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Submit failed')
    }
  }, [sessionId, code, onSuccess])

  useEffect(() => {
    closedRef.current = false
    if (open) void startLogin()
    return () => {
      closedRef.current = true
    }
  }, [open, startLogin])

  if (!open) return null

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(authUrl)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="w-full max-w-[440px] rounded-2xl border p-6"
        style={{
          backgroundColor: 'var(--theme-card)',
          borderColor: 'var(--theme-border)',
          color: 'var(--theme-text)',
        }}
      >
        <h3 className="mb-4 text-base font-semibold">Claude OAuth Login</h3>

        {status === 'loading' ? (
          <div className="flex min-h-[140px] items-center justify-center">
            <span className="text-sm" style={{ color: 'var(--theme-muted)' }}>
              Preparing authorization...
            </span>
          </div>
        ) : status === 'waiting' || status === 'submitting' ? (
          <div className="space-y-4">
            <p
              className="text-center text-sm"
              style={{ color: 'var(--theme-muted)' }}
            >
              Authorize Claude in the browser window. After authorizing, paste
              the authorization code below and click Submit.
            </p>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() =>
                  window.open(authUrl, '_blank', 'noopener,noreferrer')
                }
              >
                Open authorization page
              </Button>
              <Button variant="outline" onClick={() => void copyLink()}>
                Copy link
              </Button>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submitCode()
                }
              }}
              placeholder="Paste authorization code here"
              rows={3}
              className="w-full resize-y rounded-lg border px-3 py-2 font-mono text-sm outline-none"
              style={{
                borderColor: 'var(--theme-border)',
                backgroundColor: 'var(--theme-bg)',
                color: 'var(--theme-text)',
              }}
            />
            <Button
              className="w-full"
              disabled={!code.trim() || status === 'submitting'}
              onClick={() => void submitCode()}
            >
              {status === 'submitting' ? 'Submitting...' : 'Submit code'}
            </Button>
          </div>
        ) : status === 'approved' ? (
          <div className="flex min-h-[140px] flex-col items-center justify-center gap-3 text-green-500">
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
          <div className="flex min-h-[140px] flex-col items-center justify-center gap-3">
            <p className="text-sm text-red-400">
              Authorization expired. Please try again.
            </p>
            <Button size="sm" onClick={() => void startLogin()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex min-h-[140px] flex-col items-center justify-center gap-3">
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
            disabled={status === 'submitting'}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
