/**
 * Lazy gateway residency: cold-start on first use, LRU eviction when more
 * than N profiles stay warm simultaneously.
 *
 * `default` is pinned: never LRU-evicted, and restarted if it dies.
 * It still counts toward maxResident so the pool stays at most N warm
 * processes (default + up to N-1 others).
 *
 * Idle TTL is off by default. Set HERMES_GATEWAY_IDLE_TTL (seconds) to
 * opt back into time-based eviction.
 */
import { getActiveProfileName } from './profiles-browser'
import {
  isHermesAgentHealthy,
  stopProfileGateway,
} from './hermes-agent'
import {
  isGatewayPoolEnabled,
  listManagedProfileNames,
  listPersistedOrphanProfilePorts,
  PINNED_GATEWAY_PROFILE,
  resolveProfileGatewayPort,
} from './gateway-ports'
import { pidListeningOnPort } from './gateway-port-owner'

export { PINNED_GATEWAY_PROFILE }

export type GatewayLifecycleConfig = {
  maxResident: number
  idleTtlMs: number
  evictIntervalMs: number
}

export type GatewayLease = {
  profile: string
  lastUsedAt: number
  startedAt: number
}

const DEFAULT_MAX_RESIDENT = 8
const DEFAULT_IDLE_TTL_SEC = 0
const DEFAULT_EVICT_INTERVAL_SEC = 60

const leases = new Map<string, GatewayLease>()
const EVICT_TIMER_KEY = Symbol.for('hermes.gateway.evictTimer')
const EVICT_GEN_KEY = Symbol.for('hermes.gateway.evictGen')
let evictInFlight: Promise<void> | null = null
let defaultEnsureDepth = 0

function bumpEvictGeneration(): number {
  const holder = globalThis as Record<symbol, number>
  holder[EVICT_GEN_KEY] = (holder[EVICT_GEN_KEY] ?? 0) + 1
  return holder[EVICT_GEN_KEY]
}

function currentEvictGeneration(): number {
  return (globalThis as Record<symbol, number>)[EVICT_GEN_KEY] ?? 0
}

function getEvictTimer(): ReturnType<typeof setInterval> | null {
  const holder = globalThis as Record<
    symbol,
    ReturnType<typeof setInterval> | undefined
  >
  return holder[EVICT_TIMER_KEY] ?? null
}

function setEvictTimer(timer: ReturnType<typeof setInterval> | null): void {
  const holder = globalThis as Record<
    symbol,
    ReturnType<typeof setInterval> | null
  >
  const previous = holder[EVICT_TIMER_KEY]
  if (previous && previous !== timer) {
    clearInterval(previous)
  }
  holder[EVICT_TIMER_KEY] = timer
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function readGatewayLifecycleConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayLifecycleConfig {
  return {
    maxResident: readPositiveInt(
      env.HERMES_GATEWAY_POOL_MAX,
      DEFAULT_MAX_RESIDENT,
    ),
    idleTtlMs:
      readNonNegativeInt(env.HERMES_GATEWAY_IDLE_TTL, DEFAULT_IDLE_TTL_SEC) *
      1000,
    evictIntervalMs:
      readPositiveInt(
        env.HERMES_GATEWAY_EVICT_INTERVAL,
        DEFAULT_EVICT_INTERVAL_SEC,
      ) * 1000,
  }
}

export function getGatewayLeases(): Array<GatewayLease> {
  return [...leases.values()]
}

export function touchGatewayLease(profileName: string, at = Date.now()): void {
  if (!isGatewayPoolEnabled()) return
  const name = (profileName || 'default').trim() || 'default'
  const existing = leases.get(name)
  if (existing) {
    existing.lastUsedAt = at
    return
  }
  leases.set(name, { profile: name, lastUsedAt: at, startedAt: at })
}

export function clearGatewayLease(profileName: string): void {
  const name = (profileName || 'default').trim() || 'default'
  leases.delete(name)
}

export function normalizeGatewayProfileName(profileName: string): string {
  return (
    (profileName || PINNED_GATEWAY_PROFILE).trim() || PINNED_GATEWAY_PROFILE
  )
}

export function isPinnedGatewayProfile(profileName: string): boolean {
  return normalizeGatewayProfileName(profileName) === PINNED_GATEWAY_PROFILE
}

/** Background spawn must not steal chat traffic from the current active profile. */
export function shouldApplyGatewayRoute(
  ensuringProfile: string,
  activeProfile: string,
): boolean {
  return (
    normalizeGatewayProfileName(ensuringProfile) ===
    normalizeGatewayProfileName(activeProfile)
  )
}

async function isProfileGatewayRunning(profileName: string): Promise<boolean> {
  try {
    // Dynamic: breaks gateway-pool ↔ gateway-lifecycle cycle.
    const { probeProfileGateway } = await import('./gateway-pool')
    return await probeProfileGateway(profileName)
  } catch {
    return isHermesAgentHealthy(resolveProfileGatewayPort(profileName), 250)
  }
}

/**
 * Pure eviction planner — exported for unit tests.
 * Never evicts `default` or profiles in `protectedProfiles`.
 * maxResident counts the full remaining set, including pinned/active.
 */
export function selectEvictionCandidates(
  running: Array<GatewayLease>,
  options: {
    now: number
    idleTtlMs: number
    maxResident: number
    protectedProfiles: Set<string>
  },
): Array<string> {
  const protectedProfiles = new Set(options.protectedProfiles)
  protectedProfiles.add(PINNED_GATEWAY_PROFILE)

  const toEvict = new Set<string>()
  if (options.idleTtlMs > 0) {
    for (const lease of running) {
      if (protectedProfiles.has(lease.profile)) continue
      if (options.now - lease.lastUsedAt > options.idleTtlMs) {
        toEvict.add(lease.profile)
      }
    }
  }

  const remaining = running.filter((lease) => !toEvict.has(lease.profile))
  const evictable = remaining
    .filter((lease) => !protectedProfiles.has(lease.profile))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)

  let overflow = remaining.length - options.maxResident
  while (overflow > 0 && evictable.length > 0) {
    const oldest = evictable.shift()
    if (!oldest) break
    toEvict.add(oldest.profile)
    overflow -= 1
  }

  return [...toEvict]
}

async function listRunningLeases(): Promise<Array<GatewayLease>> {
  const running: Array<GatewayLease> = []
  for (const name of listManagedProfileNames()) {
    if (!(await isProfileGatewayRunning(name))) continue
    const lease = leases.get(name) ?? {
      profile: name,
      lastUsedAt: Date.now(),
      startedAt: Date.now(),
    }
    running.push(lease)
    if (!leases.has(name)) {
      leases.set(name, lease)
    }
  }
  return running
}

export async function runEvictionCycle(options?: {
  incomingProfile?: string
}): Promise<Array<string>> {
  if (!isGatewayPoolEnabled()) return []

  const config = readGatewayLifecycleConfig()
  const now = Date.now()
  const protectedProfiles = new Set<string>()
  const active = getActiveProfileName()
  if (active) protectedProfiles.add(active)
  const incoming = options?.incomingProfile?.trim()
  if (incoming) protectedProfiles.add(incoming)

  const running = await listRunningLeases()
  const victims = selectEvictionCandidates(running, {
    now,
    idleTtlMs: config.idleTtlMs,
    maxResident: config.maxResident,
    protectedProfiles,
  })

  for (const profile of victims) {
    if (isPinnedGatewayProfile(profile)) continue
    const stopped = stopProfileGateway(profile)
    clearGatewayLease(profile)
    if (stopped.ok) {
      console.log(`[gateway-pool] evicted gateway for profile ${profile}`)
    }
  }

  await ensureDefaultResidentGateway()
  return victims
}

/** Keep the default gateway warm; never steal HERMES_API unless it is active. */
export async function ensureDefaultResidentGateway(): Promise<void> {
  if (!isGatewayPoolEnabled()) return
  if (defaultEnsureDepth > 0) return
  defaultEnsureDepth += 1
  try {
    if (await isProfileGatewayRunning(PINNED_GATEWAY_PROFILE)) {
      touchGatewayLease(PINNED_GATEWAY_PROFILE)
      return
    }
    // Dynamic: breaks gateway-pool ↔ gateway-lifecycle cycle.
    const { ensureProfileGateway } = await import('./gateway-pool')
    await ensureProfileGateway(PINNED_GATEWAY_PROFILE)
  } catch (error) {
    console.warn(
      `[gateway-pool] failed to keep default gateway resident: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  } finally {
    defaultEnsureDepth -= 1
  }
}

export function ensureGatewayLifecycleScheduler(): void {
  if (!isGatewayPoolEnabled()) return
  const generation = bumpEvictGeneration()
  if (getEvictTimer()) {
    setEvictTimer(null)
  }

  const { evictIntervalMs } = readGatewayLifecycleConfig()
  const timer = setInterval(() => {
    if (currentEvictGeneration() !== generation) return
    if (evictInFlight) return
    evictInFlight = runEvictionCycle()
      .then(() => undefined)
      .catch((error) => {
        console.warn(
          `[gateway-pool] eviction cycle failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
      .finally(() => {
        evictInFlight = null
      })
  }, evictIntervalMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }
  setEvictTimer(timer)

  const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } })
    .hot
  hot?.dispose(() => {
    if (currentEvictGeneration() === generation) {
      bumpEvictGeneration()
      setEvictTimer(null)
    }
  })

  void ensureDefaultResidentGateway()
  void reconcileRemovedProfileGateways()
}

/** Stop gateways for profiles removed from disk but still listed in gateway-pool.json. */
export async function reconcileRemovedProfileGateways(): Promise<string[]> {
  if (!isGatewayPoolEnabled()) return []
  const orphans = listPersistedOrphanProfilePorts()
  if (orphans.length === 0) return []

  const stopped: string[] = []
  for (const { profile, port } of orphans) {
    stopProfileGateway(profile)
    const pid = pidListeningOnPort(port)
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
        stopped.push(profile)
        console.log(
          `[gateway-pool] stopped orphan gateway for removed profile ${profile} on :${port}`,
        )
      } catch (error) {
        const errno = error as NodeJS.ErrnoException
        if (errno.code !== 'ESRCH') {
          console.warn(
            `[gateway-pool] failed to stop orphan gateway for ${profile} on :${port}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    }
    clearGatewayLease(profile)
  }

  // Rewrite gateway-pool.json without removed profiles.
  resolveProfileGatewayPort(PINNED_GATEWAY_PROFILE)
  return stopped
}

/** Evict before spawning a new resident gateway (capacity / idle). */
export async function evictBeforeGatewayStart(
  profileName: string,
): Promise<void> {
  if (!isGatewayPoolEnabled()) return
  await runEvictionCycle({ incomingProfile: profileName })
}
