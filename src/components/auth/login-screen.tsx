import { useState } from 'react'
import type { FormEvent } from 'react'

export function LoginScreen() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      const data = await res.json()

      if (data.ok) {
        // Success! Reload to trigger auth check
        window.location.reload()
      } else {
        setError(data.error || 'Invalid password')
        setLoading(false)
      }
    } catch (err) {
      setError('Authentication failed. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="app-surface flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="glass-elevated px-8 py-10">
          {/* Logo */}
          <div className="mb-8 flex justify-center">
            <div className="flex items-center gap-2.5">
              <svg
                width="32"
                height="32"
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="text-accent-500"
              >
                <path
                  d="M50 10 L90 30 L90 70 L50 90 L10 70 L10 30 Z"
                  fill="currentColor"
                  opacity="0.15"
                />
                <path
                  d="M50 25 L75 38 L75 62 L50 75 L25 62 L25 38 Z"
                  fill="currentColor"
                  opacity="0.3"
                />
                <circle cx="50" cy="50" r="15" fill="currentColor" />
              </svg>
              <h1
                className="text-[24px] font-semibold tracking-tight"
                style={{ color: 'var(--theme-text)' }}
              >
                Agorax
              </h1>
            </div>
          </div>

          {/* Title */}
          <h2
            className="mb-2 text-center text-base font-semibold"
            style={{ color: 'var(--theme-text)' }}
          >
            Enter Password
          </h2>
          <p
            className="mb-6 text-center text-sm font-normal"
            style={{ color: 'var(--theme-muted)' }}
          >
            This workspace is password-protected
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full rounded-md border px-3 outline-none transition-all focus:ring-2 focus:ring-accent-500/20"
                style={{
                  height: 'var(--control-h-md, 36px)',
                  fontSize: '14px',
                  fontWeight: 400,
                  borderColor: 'var(--theme-border)',
                  background: 'var(--theme-input)',
                  color: 'var(--theme-text)',
                }}
                disabled={loading}
                autoFocus
              />
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-800/60">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded-md bg-accent-500 text-sm font-normal text-white transition-all hover:bg-accent-600 focus:outline-none focus:ring-2 focus:ring-accent-500/50 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ height: 'var(--control-h-md, 36px)' }}
            >
              {loading ? 'Authenticating...' : 'Continue'}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p
          className="mt-6 text-center text-xs"
          style={{ color: 'var(--theme-muted)' }}
        >
          Powered by{' '}
          <a
            href="https://github.com/NousResearch/hermes-agent"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-500 hover:text-accent-600 transition-colors"
          >
            Hermes Agent
          </a>
        </p>
      </div>
    </div>
  )
}
