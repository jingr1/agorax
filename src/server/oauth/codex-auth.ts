import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  authJsonPath,
  loadAuthJson,
  saveAuthJson,
  readOAuthProviderStatus,
  readOAuthProviderError,
  type OAuthProviderStatus,
} from './auth-json-store'

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_DEVICE_AUTH_URL =
  'https://auth.openai.com/api/accounts/deviceauth/usercode'
const CODEX_DEVICE_TOKEN_URL =
  'https://auth.openai.com/api/accounts/deviceauth/token'
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const CODEX_VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const CODEX_HOME = path.join(os.homedir(), '.codex')
const POLL_MAX_DURATION = 15 * 60 * 1000
const POLL_INTERVAL = 5000

interface CodexSession {
  id: string
  userCode: string
  deviceAuthId: string
  profile: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  error?: string
  createdAt: number
}

const sessions = new Map<string, CodexSession>()

function cleanupExpiredSessions(): void {
  const now = Date.now()
  sessions.forEach((session, id) => {
    if (now - session.createdAt > POLL_MAX_DURATION + 60_000)
      sessions.delete(id)
  })
}

function saveCodexCliTokens(accessToken: string, refreshToken: string): void {
  const codexHome = process.env.CODEX_HOME || CODEX_HOME
  const codexAuthPath = path.join(codexHome, 'auth.json')
  fs.mkdirSync(path.dirname(codexAuthPath), { recursive: true })
  fs.writeFileSync(
    codexAuthPath,
    JSON.stringify(
      {
        tokens: { access_token: accessToken, refresh_token: refreshToken },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
}

function saveCodexOAuthTokens(
  profile: string,
  accessToken: string,
  refreshToken: string,
): void {
  const filePath = authJsonPath(profile)
  const auth = loadAuthJson(filePath)
  if (!auth.providers) auth.providers = {}
  auth.providers['openai-codex'] = {
    tokens: { access_token: accessToken, refresh_token: refreshToken },
    last_refresh: new Date().toISOString(),
    auth_mode: 'chatgpt',
  }
  if (!auth.credential_pool) auth.credential_pool = {}
  auth.credential_pool['openai-codex'] = [
    {
      id: `openai-codex-${Date.now()}`,
      label: 'OpenAI Codex',
      base_url: CODEX_DEFAULT_BASE_URL,
      access_token: accessToken,
      last_status: null,
    },
  ]
  // Clear any stale last_auth_error on successful login
  delete (auth.providers['openai-codex'] as Record<string, unknown>)
    .last_auth_error
  saveAuthJson(filePath, auth)
  saveCodexCliTokens(accessToken, refreshToken)
}

async function codexLoginWorker(session: CodexSession): Promise<void> {
  const startTime = Date.now()
  while (Date.now() - startTime < POLL_MAX_DURATION) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
    if (session.status !== 'pending') return
    try {
      const pollRes = await fetch(CODEX_DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: session.deviceAuthId,
          user_code: session.userCode,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (pollRes.status === 200) {
        const pollData = (await pollRes.json()) as {
          authorization_code: string
          code_verifier: string
        }
        const tokenRes = await fetch(CODEX_OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: pollData.authorization_code,
            redirect_uri: CODEX_REDIRECT_URI,
            client_id: CODEX_CLIENT_ID,
            code_verifier: pollData.code_verifier,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        })
        if (!tokenRes.ok) {
          session.status = 'error'
          session.error = `Token exchange failed: ${tokenRes.status}`
          return
        }
        const tokenData = (await tokenRes.json()) as {
          access_token: string
          refresh_token?: string
        }
        saveCodexOAuthTokens(
          session.profile,
          tokenData.access_token,
          tokenData.refresh_token || '',
        )
        session.status = 'approved'
        return
      }
      if (pollRes.status === 403 || pollRes.status === 404) continue
      session.status = 'error'
      session.error = `Poll failed: ${pollRes.status}`
      return
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name
      if (name === 'TimeoutError' || name === 'AbortError') continue
      session.status = 'error'
      session.error = err instanceof Error ? err.message : String(err)
      return
    }
  }
  session.status = 'expired'
}

export async function startCodexLogin(profile: string): Promise<
  | {
      ok: true
      session_id: string
      user_code: string
      verification_url: string
      expires_in: number
    }
  | { ok: false; error: string; code?: string }
> {
  cleanupExpiredSessions()
  const res = await fetch(CODEX_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'node-fetch',
    },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    let errorBody: Record<string, unknown> | null = null
    try {
      errorBody = (await res.json()) as Record<string, unknown>
    } catch {
      /* ignore */
    }
    const code = (errorBody?.error as Record<string, unknown>)?.code as
      | string
      | undefined
    let message = `Device code request failed: ${res.status}`
    if (code === 'unsupported_country_region_territory') {
      message =
        'OpenAI does not support your region. You may need a proxy or VPN.'
    }
    return { ok: false, error: message, code }
  }
  const data = (await res.json()) as {
    user_code: string
    device_auth_id: string
  }
  const sessionId = randomUUID()
  const session: CodexSession = {
    id: sessionId,
    userCode: data.user_code,
    deviceAuthId: data.device_auth_id,
    profile,
    status: 'pending',
    createdAt: Date.now(),
  }
  sessions.set(sessionId, session)
  codexLoginWorker(session).catch((err) => {
    session.status = 'error'
    session.error = err instanceof Error ? err.message : String(err)
  })
  return {
    ok: true,
    session_id: sessionId,
    user_code: data.user_code,
    verification_url: CODEX_VERIFICATION_URL,
    expires_in: 900,
  }
}

export function pollCodexLogin(
  sessionId: string,
): { status: string; error: string | null } | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return { status: session.status, error: session.error || null }
}

export { readOAuthProviderStatus, readOAuthProviderError }
