/**
 * Shared Hermes profile gateway probe for agent status surfaces.
 *
 * Availability follows port ownership (same signal as gateway-pool `healthy`).
 * Detail distinguishes not-running vs port-not-owned. TTL cache + per-profile
 * single-flight keep GET /api/agents from re-probing every profile on each
 * poll; negative TTL is shorter so a just-started gateway appears quickly.
 *
 * Static imports are intentional: a dynamic `import('../gateway-pool')` on the
 * first probe paid a multi-second module-graph eval and blocked the event loop
 * for every concurrent probeAll waiter (Hermes + managed).
 */
import type { AgentProbeResult } from './types'
import { probeProfileGateway } from '../gateway-pool'
import {
  getProfileGatewayUrl,
  resolveProfileGatewayPort,
} from '../gateway-ports'
import { isPortInUse } from '../gateway-port-owner'

/** Warm positive results across chat / Agents / Mission Control polls. */
const POSITIVE_CACHE_TTL_MS = 15_000
/** Negatives stay short so spawn recovery shows up within ~2s. */
const NEGATIVE_CACHE_TTL_MS = 2_000

type CacheEntry = { result: AgentProbeResult; expiresAt: number }

const CACHE_KEY = '__hermes_gateway_probe_cache__' as const
const INFLIGHT_KEY = '__hermes_gateway_probe_inflight__' as const

function getCache(): Map<string, CacheEntry> {
  const g = globalThis as Record<string, unknown>
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, CacheEntry>()
  return g[CACHE_KEY] as Map<string, CacheEntry>
}

function getInflight(): Map<string, Promise<AgentProbeResult>> {
  const g = globalThis as Record<string, unknown>
  if (!g[INFLIGHT_KEY]) {
    g[INFLIGHT_KEY] = new Map<string, Promise<AgentProbeResult>>()
  }
  return g[INFLIGHT_KEY] as Map<string, Promise<AgentProbeResult>>
}

/** Test helper: drop cached probe results. */
export function clearHermesGatewayProbeCache(): void {
  getCache().clear()
  getInflight().clear()
}

export async function probeHermesProfileGateway(
  profileName: string,
): Promise<AgentProbeResult> {
  const name = (profileName || 'default').trim() || 'default'
  const cache = getCache()
  const cached = cache.get(name)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.result

  const inflight = getInflight()
  const pending = inflight.get(name)
  if (pending) return pending

  const work = (async (): Promise<AgentProbeResult> => {
    try {
      const owned = await probeProfileGateway(name)
      const url = getProfileGatewayUrl(name)
      if (owned) {
        return {
          available: true,
          detail: `hermes gateway ${url}`,
        }
      }
      const port = resolveProfileGatewayPort(name)
      const inUse = isPortInUse(port)
      return {
        available: false,
        detail: inUse
          ? `hermes gateway port not owned (${url})`
          : `hermes gateway not running (${url})`,
      }
    } catch (error) {
      return {
        available: false,
        detail:
          error instanceof Error
            ? error.message
            : `hermes gateway probe failed: ${String(error)}`,
      }
    }
  })()
    .then((result) => {
      const ttl = result.available ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS
      cache.set(name, { result, expiresAt: Date.now() + ttl })
      return result
    })
    .finally(() => {
      inflight.delete(name)
    })

  inflight.set(name, work)
  return work
}

/** @deprecated Ownership probe no longer uses a health fetch timeout. */
export const HERMES_GATEWAY_PROBE_TIMEOUT_MS = 250
