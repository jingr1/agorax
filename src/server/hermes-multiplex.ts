/**
 * Hermes host multiplex: one default gateway serves every profile on its
 * listener. Named profiles are reached at `/p/<profile>/...` (not a second
 * API_SERVER_PORT). See NousResearch/hermes-agent gateway.multiplex_profiles.
 *
 * Leaf module: do not import gateway-ports / gateway-pool (cycle risk).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { isPortInUse, pidListeningOnPort } from './gateway-port-owner'

/** Same default as gateway-ports.GATEWAY_BASE_PORT — duplicated to stay a leaf. */
const MULTIPLEX_HOST_PORT = 8642

export type MultiplexGatewayState = {
  pid: number
  servedProfiles: Array<string>
  port: number
}

function hermesRoot(): string {
  return process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
}

function readGatewayStateFile(): Record<string, unknown> | null {
  const path = join(hermesRoot(), 'gateway_state.json')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Explicit `gateway.multiplex_profiles` (or top-level) in default config.
 * `null` = unset / unreadable.
 */
export function readMultiplexProfilesConfig(): boolean | null {
  const path = join(hermesRoot(), 'config.yaml')
  if (!existsSync(path)) return null
  try {
    const raw = YAML.parse(readFileSync(path, 'utf-8')) as unknown
    if (raw === null || typeof raw !== 'object') return null
    const root = raw as Record<string, unknown>
    const gateway =
      root.gateway !== null && typeof root.gateway === 'object'
        ? (root.gateway as Record<string, unknown>)
        : null
    const value =
      gateway && 'multiplex_profiles' in gateway
        ? gateway.multiplex_profiles
        : root.multiplex_profiles
    if (value === true || value === false) return value
    return null
  } catch {
    return null
  }
}

/**
 * Live multiplex host when gateway_state.json lists served_profiles and the
 * recorded PID still owns the API listener (or at least keeps :8642 open).
 */
export function readLiveMultiplexGateway(): MultiplexGatewayState | null {
  const state = readGatewayStateFile()
  if (!state) return null
  const pid = typeof state.pid === 'number' ? state.pid : Number(state.pid)
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null
  const served = state.served_profiles
  if (!Array.isArray(served) || served.length === 0) return null
  const profiles = served.map(String).filter(Boolean)
  if (profiles.length === 0) return null

  const port = MULTIPLEX_HOST_PORT
  const listenerPid = pidListeningOnPort(port)
  if (listenerPid != null && listenerPid !== pid) return null
  if (listenerPid == null && !isPortInUse(port)) return null

  return { pid, servedProfiles: profiles, port }
}

export function isProfileMultiplexServed(profileName: string): boolean {
  const name = (profileName || 'default').trim() || 'default'
  const live = readLiveMultiplexGateway()
  if (!live) return false
  return live.servedProfiles.includes(name)
}

/**
 * Named profiles under a multiplexing host (live or configured) must not get
 * a second API_SERVER_PORT listener — Hermes no-ops `gateway run` for them.
 */
export function shouldUseMultiplexGatewayPath(profileName: string): boolean {
  const name = (profileName || 'default').trim() || 'default'
  if (name === 'default') return false
  if (isProfileMultiplexServed(name)) return true
  if (readLiveMultiplexGateway()) return true
  return readMultiplexProfilesConfig() === true
}

export function gatewayUrlForMultiplexPort(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** Base URL for chat/API against a multiplex host / profile. */
export function multiplexProfileGatewayUrl(
  profileName: string,
  hostPort = MULTIPLEX_HOST_PORT,
): string {
  const name = (profileName || 'default').trim() || 'default'
  const live = readLiveMultiplexGateway()
  const base = gatewayUrlForMultiplexPort(live?.port ?? hostPort)
  if (name === 'default') return base
  return `${base}/p/${encodeURIComponent(name)}`
}

export async function isMultiplexProfileHealthy(
  profileName: string,
  timeoutMs = 250,
): Promise<boolean> {
  const base = multiplexProfileGatewayUrl(profileName).replace(/\/$/, '')
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return false
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/html')) return false
    if (contentType.includes('json')) return true
    const text = await response.text()
    const trimmed = text.trim()
    return trimmed.startsWith('{') || trimmed.startsWith('[')
  } catch {
    return false
  }
}
