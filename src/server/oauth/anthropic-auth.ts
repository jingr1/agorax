import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  authJsonPath,
  loadAuthJson,
  saveAuthJson,
  readOAuthProviderStatus,
  readOAuthProviderError,
  type OAuthProviderStatus,
} from './auth-json-store'

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_REDIRECT_URI =
  'https://console.anthropic.com/oauth/code/callback'
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference'
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'
const CLAUDE_OAUTH_PROVIDER = 'claude-oauth'
const ANTHROPIC_RUNTIME_PROVIDER = 'anthropic'
const POLL_MAX_DURATION = 15 * 60 * 1000

interface AnthropicSession {
  id: string
  profile: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  codeVerifier: string
  state: string
  createdAt: number
  error?: string
}

const sessions = new Map<string, AnthropicSession>()

function cleanupExpiredSessions(): void {
  const now = Date.now()
  sessions.forEach((session, id) => {
    if (now - session.createdAt > POLL_MAX_DURATION + 60_000)
      sessions.delete(id)
  })
}

function base64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makeCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

function makeCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function saveAnthropicOAuthTokens(
  profile: string,
  tokenData: {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
  },
): void {
  const accessToken = String(tokenData.access_token || '').trim()
  const refreshToken = String(tokenData.refresh_token || '').trim()
  if (!accessToken)
    throw new Error('Anthropic token response missing access_token')

  const expiresIn = Number(tokenData.expires_in || 3600)
  const expiresAtMs = Date.now() + Math.max(60, expiresIn) * 1000
  const lastRefresh = new Date().toISOString()

  const filePath = authJsonPath(profile)
  const auth = loadAuthJson(filePath)
  if (!auth.providers) auth.providers = {}
  const providerEntry = {
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at_ms: expiresAtMs,
      token_type: tokenData.token_type || 'Bearer',
    },
    last_refresh: lastRefresh,
    auth_mode: 'oauth_pkce',
    base_url: ANTHROPIC_DEFAULT_BASE_URL,
  }
  auth.providers[CLAUDE_OAUTH_PROVIDER] = providerEntry
  auth.providers[ANTHROPIC_RUNTIME_PROVIDER] = providerEntry
  if (!auth.credential_pool) auth.credential_pool = {}
  const poolEntry = {
    id: `${CLAUDE_OAUTH_PROVIDER}-${Date.now()}`,
    label: 'Claude OAuth',
    auth_type: 'oauth',
    source: 'dashboard_pkce',
    priority: 0,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at_ms: expiresAtMs,
    base_url: ANTHROPIC_DEFAULT_BASE_URL,
  }
  auth.credential_pool[CLAUDE_OAUTH_PROVIDER] = [poolEntry]
  auth.credential_pool[ANTHROPIC_RUNTIME_PROVIDER] = [
    {
      ...poolEntry,
      id: `${ANTHROPIC_RUNTIME_PROVIDER}-${Date.now()}`,
      label: 'Anthropic Claude OAuth',
    },
  ]
  saveAuthJson(filePath, auth)
}

export function startAnthropicLogin(profile: string): {
  session_id: string
  authorization_url: string
  expires_in: number
} {
  cleanupExpiredSessions()
  const codeVerifier = makeCodeVerifier()
  const codeChallenge = makeCodeChallenge(codeVerifier)
  const state = randomBytes(32).toString('base64url')
  const sessionId = randomUUID()
  const params = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: 'code',
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })
  const authorizeUrl = `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`
  sessions.set(sessionId, {
    id: sessionId,
    profile,
    status: 'pending',
    codeVerifier,
    state,
    createdAt: Date.now(),
  })
  return {
    session_id: sessionId,
    authorization_url: authorizeUrl,
    expires_in: Math.floor(POLL_MAX_DURATION / 1000),
  }
}

export async function submitAnthropicCode(
  sessionId: string,
  rawCode: string,
): Promise<{ status: string; error: string | null }> {
  const session = sessions.get(sessionId)
  if (!session) return { status: 'error', error: 'Session not found' }
  if (Date.now() - session.createdAt > POLL_MAX_DURATION) {
    session.status = 'expired'
    return { status: 'expired', error: null }
  }
  if (session.status !== 'pending') {
    return { status: session.status, error: session.error || null }
  }

  const [code, receivedState = ''] = rawCode.trim().split('#', 2)
  if (!code.trim())
    return { status: 'error', error: 'Authorization code is required' }
  if (receivedState && receivedState !== session.state) {
    session.status = 'error'
    session.error = 'OAuth state mismatch'
    return { status: 'error', error: session.error }
  }

  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'hermes-workspace/1.0',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: ANTHROPIC_CLIENT_ID,
        code: code.trim(),
        state: receivedState || session.state,
        redirect_uri: ANTHROPIC_REDIRECT_URI,
        code_verifier: session.codeVerifier,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(
        `Token exchange failed: ${res.status}${text ? ` ${text}` : ''}`,
      )
    }
    const tokenData = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      token_type?: string
    }
    saveAnthropicOAuthTokens(session.profile, tokenData)
    session.status = 'approved'
    return { status: 'approved', error: null }
  } catch (err: unknown) {
    session.status = 'error'
    session.error = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: session.error }
  }
}

export function getAnthropicSessionStatus(
  sessionId: string,
): { status: string; error: string | null } | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return { status: session.status, error: session.error || null }
}

export { readOAuthProviderStatus, readOAuthProviderError }
