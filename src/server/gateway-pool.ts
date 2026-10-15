/**
 * Multi-gateway pool: one Hermes API server per profile, lazy start,
 * LRU eviction when more than N profiles stay warm (see gateway-lifecycle.ts).
 * `default` is pinned resident; background starts never steal HERMES_API.
 */
import path from 'node:path'
import {
  getActiveProfileName,
  isLiveNamedProfile,
  resolveProfileHermesHome,
  setActiveProfile,
} from './profiles-browser'
import {
  isHermesAgentHealthy,
  spawnProfileGateway,
  startHermesAgent,
  type StartHermesAgentResult,
} from './hermes-agent'
import { applyProfileGatewayRoute } from './gateway-capabilities'
import {
  PINNED_GATEWAY_PROFILE,
  bindProfileToPort,
  gatewayUrlForPort,
  getProfileGatewayUrl,
  isGatewayPoolEnabled,
  listManagedProfileNames,
  profileNameFromHermesHome,
  resolveProfileGatewayPort,
} from './gateway-ports'
import {
  isPortInUse,
  pidListeningOnPort,
  profileOwnsPort as profileOwnsPortUnchecked,
  readProcessHermesHome,
} from './gateway-port-owner'
import {
  ensureGatewayLifecycleScheduler,
  evictBeforeGatewayStart,
  shouldApplyGatewayRoute,
  touchGatewayLease,
} from './gateway-lifecycle'

export {
  GATEWAY_BASE_PORT,
  PINNED_GATEWAY_PROFILE,
  bindProfileToPort,
  gatewayUrlForPort,
  getProfileGatewayUrl,
  isGatewayPoolEnabled,
  listManagedProfileNames,
  profileNameFromHermesHome,
  readExplicitProfilePort,
  resolveProfileGatewayPort,
  ensureProfileApiServerEnv,
} from './gateway-ports'

function profileOwnsPort(profileName: string, port: number): boolean {
  try {
    return profileOwnsPortUnchecked(profileName, port)
  } catch (error) {
    console.warn(
      `[gateway-pool] port ownership check failed for ${profileName}:${port}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return false
  }
}

export type GatewayPoolState = 'stopped' | 'spawning' | 'healthy' | 'dead'

export type PooledGateway = {
  profile: string
  port: number
  url: string
  hermesHome: string
  state: GatewayPoolState
}

export type EnsureGatewayResult = Omit<StartHermesAgentResult, 'ok' | 'error'> &
  StartHermesAgentResult & {
    port?: number
    url?: string
    started?: boolean
  }

const ensurePromises = new Map<string, Promise<EnsureGatewayResult>>()

function homesMatch(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

export function identifyPortOccupant(port: number): {
  pid: number
  hermesHome: string
  profile: string | null
} | null {
  const pid = pidListeningOnPort(port)
  if (!pid) return null
  const hermesHome = readProcessHermesHome(pid)
  return {
    pid,
    hermesHome: hermesHome || '',
    profile: hermesHome ? profileNameFromHermesHome(hermesHome) : null,
  }
}

async function vacateForeignOccupant(
  port: number,
  forProfile: string,
): Promise<void> {
  if (process.env.VITEST) return
  const occupant = identifyPortOccupant(port)
  if (!occupant) return
  if (occupant.profile === forProfile) return
  if (homesMatch(occupant.hermesHome, resolveProfileHermesHome(forProfile))) {
    return
  }

  const theirs = occupant.profile
    ? resolveProfileGatewayPort(occupant.profile)
    : null
  if (occupant.profile && theirs && theirs !== port) {
    await spawnProfileGateway({
      profileName: occupant.profile,
      port: theirs,
      forceReplace: true,
      waitForHealthy: false,
    })
  }

  try {
    process.kill(occupant.pid, 'SIGTERM')
    console.log(
      `[gateway-pool] vacated :${port} pid=${occupant.pid} profile=${occupant.profile ?? occupant.hermesHome}`,
    )
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    if (errno.code !== 'ESRCH') {
      console.warn(
        `[gateway-pool] failed to signal occupant of :${port}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = identifyPortOccupant(port)
    if (!current || current.pid !== occupant.pid) return
    await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 100))
  }

  try {
    process.kill(occupant.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Status / route probe: profile owns its listen port.
 *
 * Matches {@link getGatewayPoolStatus} (`healthy` vs `stopped`). Do **not** AND
 * a short `/health` fetch here — Agents UI polls this on a hot path, and a
 * 250ms health flake painted reachable gateways `offline` while chat
 * (`ensureProfileGateway`) still worked.
 *
 * Ensure/spawn paths that need HTTP readiness use their own `ownedHealthy`
 * loops with retries; they must not rely on this helper for that.
 */
export async function probeProfileGateway(
  profileName: string,
): Promise<boolean> {
  const port = resolveProfileGatewayPort(profileName)
  const name = (profileName || 'default').trim() || 'default'
  return profileOwnsPort(name, port)
}

export function getGatewayPoolSnapshot(): Array<PooledGateway> {
  return listManagedProfileNames().map((profile) => {
    const port = resolveProfileGatewayPort(profile)
    return {
      profile,
      port,
      url: gatewayUrlForPort(port),
      hermesHome: resolveProfileHermesHome(profile),
      state: 'stopped' as GatewayPoolState,
    }
  })
}

export async function getGatewayPoolStatus(): Promise<Array<PooledGateway>> {
  const snapshot = getGatewayPoolSnapshot()
  for (const entry of snapshot) {
    entry.state = profileOwnsPort(entry.profile, entry.port)
      ? 'healthy'
      : 'stopped'
  }
  return snapshot
}

async function applyRoute(url: string): Promise<void> {
  applyProfileGatewayRoute(url)
}

async function applyRouteIfActive(
  profileName: string,
  url: string,
): Promise<void> {
  // Pool-on chat addresses each profile directly. Rewriting HERMES_API here
  // would retarget every other in-flight 1:1 turn.
  if (isGatewayPoolEnabled()) return
  if (!shouldApplyGatewayRoute(profileName, getActiveProfileName())) return
  await applyRoute(url)
}

async function ensureProfileGatewayLocked(
  profileName: string,
  options: { forceReplace?: boolean } = {},
): Promise<EnsureGatewayResult> {
  const name = (profileName || 'default').trim() || 'default'
  const hermesHome = resolveProfileHermesHome(name)
  if (name !== PINNED_GATEWAY_PROFILE) {
    if (!isLiveNamedProfile(name)) {
      return {
        ok: false,
        error: `profile "${name}" does not exist`,
        profile: name,
        hermesHome,
        port: resolveProfileGatewayPort(name),
        url: gatewayUrlForPort(resolveProfileGatewayPort(name)),
        started: false,
      }
    }
  }
  const port = resolveProfileGatewayPort(name)
  const url = gatewayUrlForPort(port)
  await applyRouteIfActive(name, url)

  if (
    !options.forceReplace &&
    profileOwnsPort(name, port) &&
    (await isHermesAgentHealthy(port, 250))
  ) {
    touchGatewayLease(name)
    return {
      ok: true,
      message: 'already running',
      profile: name,
      hermesHome,
      port,
      url,
      started: false,
    }
  }

  if (!profileOwnsPort(name, port) && isPortInUse(port)) {
    const occupant = identifyPortOccupant(port)
    if (occupant && occupant.profile !== name) {
      await vacateForeignOccupant(port, name)
    }
    if (
      !profileOwnsPort(name, port) &&
      isPortInUse(port) &&
      !identifyPortOccupant(port)
    ) {
      return {
        ok: false,
        error: `port ${port} is occupied by a non-Hermes process`,
        port,
        url,
        started: false,
      }
    }
  }

  if (!profileOwnsPort(name, port) && (await isHermesAgentHealthy(port, 200))) {
    await vacateForeignOccupant(port, name)
  }

  const owned = profileOwnsPort(name, port)
  const healthy = await isHermesAgentHealthy(port, 250)
  const forceReplace = options.forceReplace === true || (healthy && !owned)

  await evictBeforeGatewayStart(name)

  const spawned = await spawnProfileGateway({
    profileName: name,
    port,
    forceReplace,
  })

  const ownedHealthy = async () =>
    profileOwnsPort(name, port) && (await isHermesAgentHealthy(port, 200))

  if (spawned.ok) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await ownedHealthy()) break
      await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 100))
    }
  }

  if (spawned.ok && (await ownedHealthy())) {
    bindProfileToPort(name, port)
    await applyRouteIfActive(name, url)
    touchGatewayLease(name)
    return {
      ...spawned,
      port,
      url,
      started: spawned.message === 'started' || spawned.message === 'restarted',
    }
  }

  let occupant = identifyPortOccupant(port)
  if (occupant && !homesMatch(occupant.hermesHome, hermesHome)) {
    await vacateForeignOccupant(port, name)
    const retried = await spawnProfileGateway({
      profileName: name,
      port,
      forceReplace: true,
    })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await ownedHealthy()) break
      await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 100))
    }
    occupant = identifyPortOccupant(port)
    if (retried.ok && (await ownedHealthy())) {
      bindProfileToPort(name, port)
      await applyRouteIfActive(name, url)
      touchGatewayLease(name)
      return {
        ...retried,
        port,
        url,
        started: true,
      }
    }
    return {
      ok: false,
      error: `port ${port} is occupied by ${occupant?.profile ?? occupant?.hermesHome ?? 'another process'}, not ${name}`,
      port,
      url,
      started: false,
    }
  }

  return {
    ok: false,
    error:
      ('error' in spawned && spawned.error) ||
      `gateway for ${name} did not bind ${url} with HERMES_HOME=${hermesHome}`,
    port,
    url,
    started: false,
  }
}

/** Start (or adopt) the gateway for one profile. Evicts idle peers when needed. */
export async function ensureProfileGateway(
  profileName: string,
  options: { forceReplace?: boolean } = {},
): Promise<EnsureGatewayResult> {
  const name = (profileName || 'default').trim() || 'default'
  if (!isGatewayPoolEnabled()) {
    const port = resolveProfileGatewayPort(name)
    return {
      ok: true,
      message: 'pool disabled',
      profile: name,
      hermesHome: resolveProfileHermesHome(name),
      port,
      url: gatewayUrlForPort(port),
      started: false,
    }
  }
  ensureGatewayLifecycleScheduler()
  const key = `${name}:${options.forceReplace ? 'replace' : 'ensure'}`
  const existing = ensurePromises.get(key)
  if (existing) return existing

  const pending = ensureProfileGatewayLocked(name, options).finally(() => {
    ensurePromises.delete(key)
  })
  ensurePromises.set(key, pending)
  return pending
}

export async function ensureActiveProfileGateway(options?: {
  forceReplace?: boolean
}): Promise<EnsureGatewayResult> {
  if (!isGatewayPoolEnabled()) {
    const started = await startHermesAgent({
      profileName: getActiveProfileName(),
      forceReplace: options?.forceReplace,
    })
    return started
  }
  const name = getActiveProfileName() || 'default'
  const result = await ensureProfileGateway(name, options)
  if (result.ok && (await probeProfileGateway(name))) {
    await applyRoute(getProfileGatewayUrl(name))
    return result
  }

  if (name !== PINNED_GATEWAY_PROFILE) {
    console.warn(
      `[gateway-pool] ${name} gateway unavailable (${'error' in result ? result.error : 'unhealthy'}); falling back to ${PINNED_GATEWAY_PROFILE}`,
    )
    // Heal Workspace selection when the named profile is gone/tombstoned so
    // the next boot does not keep trying to spawn it.
    if (
      'error' in result &&
      typeof result.error === 'string' &&
      result.error.includes('does not exist')
    ) {
      try {
        setActiveProfile(PINNED_GATEWAY_PROFILE)
      } catch {
        /* ignore */
      }
    }
    const fallback = await ensureProfileGateway(PINNED_GATEWAY_PROFILE, options)
    if (fallback.ok && (await probeProfileGateway(PINNED_GATEWAY_PROFILE))) {
      await applyRoute(getProfileGatewayUrl(PINNED_GATEWAY_PROFILE))
      return fallback
    }
  }

  return result
}

export async function syncActiveProfileGatewayRoute(): Promise<string | null> {
  if (!isGatewayPoolEnabled()) return null
  const name = getActiveProfileName() || 'default'
  if (await probeProfileGateway(name)) {
    const url = getProfileGatewayUrl(name)
    await applyRoute(url)
    return url
  }
  if (
    name !== PINNED_GATEWAY_PROFILE &&
    (await probeProfileGateway(PINNED_GATEWAY_PROFILE))
  ) {
    const url = getProfileGatewayUrl(PINNED_GATEWAY_PROFILE)
    await applyRoute(url)
    return url
  }
  return null
}
