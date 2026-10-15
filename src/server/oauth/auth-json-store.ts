import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type AuthJson = {
  version?: number
  active_provider?: string
  providers?: Record<string, unknown>
  credential_pool?: Record<string, unknown[]>
  updated_at?: string
}

export type OAuthProviderStatus = 'connected' | 'relogin_required' | 'missing'

function getHermesRoot(): string {
  return (
    process.env.HERMES_HOME ??
    process.env.HERMES_HOME ??
    path.join(os.homedir(), '.hermes')
  )
}

function getProfileDir(profile: string): string {
  const trimmed = (profile || 'default').trim() || 'default'
  if (trimmed === 'default') return getHermesRoot()
  return path.join(getHermesRoot(), 'profiles', trimmed)
}

export function authJsonPath(profile: string): string {
  return path.join(getProfileDir(profile), 'auth.json')
}

export function loadAuthJson(filePath: string): AuthJson {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AuthJson
  } catch {
    return { version: 1 }
  }
}

export function saveAuthJson(filePath: string, data: AuthJson): void {
  data.updated_at = new Date().toISOString()
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', {
    mode: 0o600,
  })
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the OAuth status for a provider from auth.json.
 * Checks providers.<providerId>.tokens.access_token + last_auth_error.
 */
export function readOAuthProviderStatus(
  profilePath: string,
  providerId: string,
): OAuthProviderStatus {
  const filePath = path.join(profilePath, 'auth.json')
  if (!fs.existsSync(filePath)) return 'missing'
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >
    const providers = readRecord(raw.providers) || raw
    const provider = readRecord(providers[providerId])
    if (!provider) return 'missing'

    const lastErr = readRecord(provider.last_auth_error)
    if (lastErr && lastErr.relogin_required === true) return 'relogin_required'

    const tokens = readRecord(provider.tokens)
    if (!tokens) return 'missing'
    if (readString(tokens.access_token)) return 'connected'
    return 'missing'
  } catch {
    return 'missing'
  }
}

/**
 * Read the last_auth_error message if any.
 */
export function readOAuthProviderError(
  profilePath: string,
  providerId: string,
): string {
  const filePath = path.join(profilePath, 'auth.json')
  if (!fs.existsSync(filePath)) return ''
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >
    const providers = readRecord(raw.providers) || raw
    const provider = readRecord(providers[providerId])
    if (!provider) return ''
    const err = readRecord(provider.last_auth_error)
    return err ? readString(err.message) : ''
  } catch {
    return ''
  }
}

/**
 * Resolve profile name from request query / body / header.
 */
export function resolveRequestProfile(request: Request): string {
  const url = new URL(request.url)
  return (
    url.searchParams.get('profile')?.trim() ||
    request.headers.get('x-hermes-profile')?.trim() ||
    'default'
  )
}

/**
 * List all unique profile directories (for writing auth to all profiles).
 */
export function listProfileDirs(): Array<{ name: string; dir: string }> {
  const root = getHermesRoot()
  const results: Array<{ name: string; dir: string }> = [
    { name: 'default', dir: root },
  ]
  const profilesRoot = path.join(root, 'profiles')
  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-z0-9][a-z0-9_-]*$/.test(entry.name)) {
        results.push({
          name: entry.name,
          dir: path.join(profilesRoot, entry.name),
        })
      }
    }
  }
  return results
}
