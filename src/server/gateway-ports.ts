/**
 * Stable per-profile API gateway ports. No process spawning — safe to import
 * from capability probes.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {
  getProfilesRoot,
  resolveProfileHermesHome,
  isLiveNamedProfile,
  isNamedProfileDeleted,
} from './profiles-browser'
import { ensureSwarmProfileConfig } from './swarm-profile-config'
import { getStateDir } from './workspace-state-dir'

export const GATEWAY_BASE_PORT = 8642
/** Always-resident profile. Kept here to avoid gateway-pool ↔ lifecycle cycles. */
export const PINNED_GATEWAY_PROFILE = 'default'
const MIN_PORT = 1024
const MAX_PORT = 65535

type PoolFile = {
  ports?: Record<string, number>
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

function isLoopbackUrl(raw: string): boolean {
  try {
    return isLoopbackHost(new URL(raw).hostname)
  } catch {
    return false
  }
}

export function pairingGatewayUrl(): string {
  try {
    const raw = fs.readFileSync(
      path.join(getStateDir(), 'workspace-overrides.json'),
      'utf-8',
    )
    const parsed = JSON.parse(raw) as { claudeApiUrl?: unknown }
    if (typeof parsed.claudeApiUrl === 'string' && parsed.claudeApiUrl.trim()) {
      return parsed.claudeApiUrl.trim()
    }
  } catch {
    // no override file
  }
  return (
    process.env.HERMES_API_URL?.trim() ||
    `http://127.0.0.1:${GATEWAY_BASE_PORT}`
  )
}

function envFlag(name: string): string {
  return (process.env[name] ?? '').trim().toLowerCase()
}

/** Localhost deployments get a pool; remote pairing stays single-gateway. */
export function isGatewayPoolEnabled(): boolean {
  const flag = envFlag('HERMES_GATEWAY_POOL')
  if (flag === '0' || flag === 'false' || flag === 'off') return false
  if (flag === '1' || flag === 'true' || flag === 'on') return true
  return isLoopbackUrl(pairingGatewayUrl())
}

export function gatewayUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= MIN_PORT && value <= MAX_PORT) return value
    return null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const port = Number(trimmed)
  if (port < MIN_PORT || port > MAX_PORT) return null
  return port
}

export function readProfileApiServerKey(profileName: string): string {
  const name = (profileName || 'default').trim() || 'default'
  const home = resolveProfileHermesHome(name)
  const envPath = path.join(home, '.env')
  const current = fs.existsSync(envPath) ? readDotEnvMap(envPath) : {}
  const key = (current.API_SERVER_KEY || '').trim()
  if (key) return key
  if (name === 'default') return ''
  const root = hermesRootFromHome(home, name)
  return (readDotEnvMap(path.join(root, '.env')).API_SERVER_KEY || '').trim()
}

function readDotEnvMap(envPath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(envPath, 'utf-8')
    const result: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (key) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

function envIsSharedWithRoot(profileHome: string, hermesRoot: string): boolean {
  const envPath = path.join(profileHome, '.env')
  const rootEnv = path.join(hermesRoot, '.env')
  try {
    if (!fs.lstatSync(envPath).isSymbolicLink()) return false
    // realpath both sides — macOS tmp/home paths often differ by /private prefix.
    return fs.realpathSync(envPath) === fs.realpathSync(rootEnv)
  } catch {
    return false
  }
}

function hermesRootFromHome(profileHome: string, profileName: string): string {
  if (profileName === 'default') return profileHome
  const marker = `${path.sep}profiles${path.sep}`
  const idx = profileHome.lastIndexOf(marker)
  if (idx >= 0) return profileHome.slice(0, idx)
  return path.dirname(path.dirname(profileHome))
}

/** Port from this profile's own .env / config.yaml. Shared .env symlinks are ignored. */
export function readExplicitProfilePort(profileName: string): number | null {
  const home = resolveProfileHermesHome(profileName)
  const root = hermesRootFromHome(home, profileName)
  const envPath = path.join(home, '.env')
  if (fs.existsSync(envPath) && !envIsSharedWithRoot(home, root)) {
    const fromEnv = parsePort(readDotEnvMap(envPath).API_SERVER_PORT)
    if (fromEnv) return fromEnv
  }

  const configPath = path.join(home, 'config.yaml')
  if (!fs.existsSync(configPath)) return null
  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const gateway = (parsed as Record<string, unknown>).gateway
    if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) {
      return null
    }
    const apiServer = (gateway as Record<string, unknown>).api_server
    if (
      !apiServer ||
      typeof apiServer !== 'object' ||
      Array.isArray(apiServer)
    ) {
      return null
    }
    return parsePort((apiServer as Record<string, unknown>).port)
  } catch {
    return null
  }
}

function poolFilePath(): string {
  return path.join(getStateDir(), 'gateway-pool.json')
}

function loadPersistedPorts(): Record<string, number> {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(poolFilePath(), 'utf-8'),
    ) as PoolFile
    if (!parsed?.ports || typeof parsed.ports !== 'object') return {}
    const ports: Record<string, number> = {}
    for (const [name, value] of Object.entries(parsed.ports)) {
      const port = parsePort(value)
      if (port) ports[name] = port
    }
    return ports
  } catch {
    return {}
  }
}

function persistPorts(ports: Record<string, number>): void {
  const file = poolFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ ports }, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch (error) {
    console.warn(
      `[gateway-pool] failed to persist port map: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function upsertDotEnv(envPath: string, updates: Record<string, string>): void {
  let raw = ''
  try {
    raw = fs.readFileSync(envPath, 'utf-8')
  } catch {
    raw = ''
  }
  const seen = new Set<string>()
  const lines = raw.length > 0 ? raw.split('\n') : []
  const next = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) return line
    const key = trimmed.slice(0, eqIdx).trim()
    if (!(key in updates)) return line
    seen.add(key)
    return `${key}=${updates[key]}`
  })
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue
    if (next.length > 0 && next[next.length - 1] !== '') next.push('')
    next.push(`${key}=${value}`)
  }
  const body = `${next.join('\n').replace(/\n+$/, '')}\n`
  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(envPath, body, { encoding: 'utf-8', mode: 0o600 })
}

/**
 * Hermes only binds `/health` when the profile .env has a usable
 * API_SERVER_KEY. Named profiles that omit the key (and the pool port)
 * come up as cron-only processes, so chat routes to a dead port.
 *
 * Hermes loads `HERMES_HOME/.env` with `override=True`, so a spawn-time
 * `API_SERVER_PORT` is overwritten by whatever is on disk. A profile
 * `.env` symlink to `~/.hermes/.env` is a configuration error — refuse
 * to start rather than rewrite the operator's files.
 */
export function ensureProfileApiServerEnv(
  profileName: string,
  port: number,
): Record<string, string> {
  const name = (profileName || 'default').trim() || 'default'
  const assigned = parsePort(port)
  if (!assigned) return {}
  const home = resolveProfileHermesHome(name)
  // Never mkdir a missing/tombstoned named profile — that is how deleted
  // test profiles like swarmtest1 get resurrected after `rm -rf`.
  if (name !== 'default' && !isLiveNamedProfile(name)) {
    throw new Error(`profile "${name}" does not exist`)
  }
  const root = hermesRootFromHome(home, name)
  const envPath = path.join(home, '.env')
  if (envIsSharedWithRoot(home, root)) {
    // Legacy profiles often symlink `.env` to the hermes root. Auto-heal into a
    // private copy (API_SERVER_PORT stripped) so this profile can bind its own port.
    ensureSwarmProfileConfig(home, { hermesRoot: root })
    if (envIsSharedWithRoot(home, root)) {
      throw new Error(
        `profile ${name} .env is a symlink to the hermes root .env; ` +
          `replace it with a private file so API_SERVER_PORT can differ from default ` +
          `(run swarm profile bootstrap, or copy ~/.hermes/.env → ${envPath} and set API_SERVER_PORT=${assigned})`,
      )
    }
  }
  const current = fs.existsSync(envPath) ? readDotEnvMap(envPath) : {}
  const defaultEnv =
    name === 'default' ? current : readDotEnvMap(path.join(root, '.env'))
  const key = (
    current.API_SERVER_KEY ||
    process.env.API_SERVER_KEY ||
    defaultEnv.API_SERVER_KEY ||
    ''
  ).trim()
  const host = (current.API_SERVER_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const updates: Record<string, string> = {
    API_SERVER_ENABLED: 'true',
    API_SERVER_PORT: String(assigned),
    API_SERVER_HOST: host,
  }
  if (key.length >= 16 && !current.API_SERVER_KEY) {
    updates.API_SERVER_KEY = key
  }
  try {
    upsertDotEnv(envPath, updates)
  } catch (error) {
    console.warn(
      `[gateway-pool] failed to persist API server env for ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return {
    API_SERVER_ENABLED: 'true',
    API_SERVER_PORT: String(assigned),
    API_SERVER_HOST: host,
    ...(key.length >= 16 ? { API_SERVER_KEY: key } : {}),
  }
}

/**
 * Profile names that own a gateway port. Names only — never call heavy
 * `listProfiles()` (YAML + recursive skill/session walks). That path was
 * invoked from every `resolveProfileGatewayPort` during `/api/agents`
 * probeAll and blocked the event loop for multiple seconds.
 */
export function listManagedProfileNames(): string[] {
  const names = new Set<string>(['default'])
  try {
    const profilesRoot = getProfilesRoot()
    if (!fs.existsSync(profilesRoot)) {
      return ['default']
    }
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      const name = entry.name
      if (!name || name === 'default' || name.startsWith('.')) continue
      if (isNamedProfileDeleted(name)) continue
      const profilePath = path.join(profilesRoot, name)
      if (entry.isDirectory()) {
        names.add(name)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      try {
        if (fs.statSync(profilePath).isDirectory()) names.add(name)
      } catch {
        // dangling symlink
      }
    }
  } catch {
    // filesystem listing can fail in tests / missing dirs
  }
  const rest = [...names]
    .filter((name) => name !== 'default')
    .sort((a, b) => a.localeCompare(b))
  return ['default', ...rest]
}

function nextFreePort(used: Set<number>, preferred: number): number {
  let port = preferred
  while (used.has(port) && port <= MAX_PORT) port += 1
  return port
}

const PORT_ASSIGNMENT_TTL_MS = 30_000
let portAssignmentCache: {
  at: number
  hermesRoot: string
  namesKey: string
  ports: Record<string, number>
} | null = null

/** Drop memoized ports (profile create/delete, tests). */
export function clearPortAssignmentCache(): void {
  portAssignmentCache = null
}

function ensurePortAssignments(): Record<string, number> {
  // Names listing is cheap (readdir). Rebuild only when the set changes or
  // the TTL expires — never re-walk skills/sessions for every port lookup.
  const hermesRoot = resolveProfileHermesHome('default')
  const names = listManagedProfileNames()
  const namesKey = names.join('\0')
  if (
    portAssignmentCache &&
    portAssignmentCache.hermesRoot === hermesRoot &&
    portAssignmentCache.namesKey === namesKey &&
    Date.now() - portAssignmentCache.at < PORT_ASSIGNMENT_TTL_MS
  ) {
    return portAssignmentCache.ports
  }

  const persisted = loadPersistedPorts()
  const used = new Set<number>()
  const next: Record<string, number> = {}

  const defaultExplicit = readExplicitProfilePort('default')
  next.default = defaultExplicit ?? GATEWAY_BASE_PORT
  used.add(next.default)

  for (const name of names) {
    if (name === 'default') continue
    const explicit = readExplicitProfilePort(name)
    if (explicit && !used.has(explicit)) {
      next[name] = explicit
      used.add(explicit)
    }
  }

  for (const name of names) {
    if (next[name]) continue
    const existing = persisted[name]
    if (existing && !used.has(existing)) {
      next[name] = existing
      used.add(existing)
    }
  }

  for (const name of names) {
    if (next[name]) continue
    const assigned = nextFreePort(used, GATEWAY_BASE_PORT + 1)
    next[name] = assigned
    used.add(assigned)
  }

  const managed = new Set(names)
  const changed =
    names.length !== Object.keys(persisted).length ||
    names.some((name) => persisted[name] !== next[name]) ||
    Object.keys(persisted).some((name) => !managed.has(name))
  if (changed) persistPorts(next)
  portAssignmentCache = {
    at: Date.now(),
    hermesRoot,
    namesKey,
    ports: next,
  }
  return next
}

/** Ports in gateway-pool.json for profiles that no longer exist on disk. */
export function listPersistedOrphanProfilePorts(): Array<{
  profile: string
  port: number
}> {
  const persisted = loadPersistedPorts()
  const managed = new Set(listManagedProfileNames())
  const orphans: Array<{ profile: string; port: number }> = []
  for (const [profile, port] of Object.entries(persisted)) {
    if (managed.has(profile)) continue
    const parsed = parsePort(port)
    if (parsed) orphans.push({ profile, port: parsed })
  }
  return orphans
}

/**
 * Stable port for a profile. Explicit per-profile config wins; otherwise
 * default=8642 and the rest fill 8643+ in name order, persisted so adding a
 * new profile does not reshuffle existing assignments.
 */
export function resolveProfileGatewayPort(profileName: string): number {
  const name = (profileName || 'default').trim() || 'default'
  const assigned = ensurePortAssignments()
  return assigned[name] ?? GATEWAY_BASE_PORT
}

export function getProfileGatewayUrl(profileName: string): string {
  return gatewayUrlForPort(resolveProfileGatewayPort(profileName))
}

export function profileNameFromHermesHome(hermesHome: string): string | null {
  const resolved = path.resolve(hermesHome)
  const defaultHome = path.resolve(resolveProfileHermesHome('default'))
  if (resolved === defaultHome) return 'default'
  const marker = `${path.sep}profiles${path.sep}`
  const idx = resolved.lastIndexOf(marker)
  if (idx < 0) return null
  const name = resolved.slice(idx + marker.length).split(path.sep)[0]
  if (!name) return null
  return name
}

/**
 * Predetermined ports are stable. Live occupancy must not steal another
 * profile's assignment — this is a no-op if `port` is not already `name`'s
 * mapped port.
 */
export function bindProfileToPort(name: string, port: number): void {
  const normalized = (name || 'default').trim() || 'default'
  const assigned = parsePort(port)
  if (!assigned) return
  const ports = ensurePortAssignments()
  if (ports[normalized] === assigned) return
}
