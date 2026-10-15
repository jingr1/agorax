/**
 * AgentRuntimeRouter — resolves agent id → adapter, owns probe() and
 * status aggregation. hermes agents are intentionally NOT adapted here:
 * they keep their existing send-stream / swarm-dispatch path (plan:
 * «hermes：完全不动») and appear in status via a read-only stub that
 * *does* probe the profile's gateway health so UI status reflects reachability.
 *
 * All managed backends (claude-code, codex, cursor, opencode, kimi) go through
 * AgoraxManagedAgentBridge → daemon targets. There is no local CLI adapter
 * fallback — without AGORAX_MANAGED_AGENT_URL the slot is unavailable.
 */
import { loadAgentsRegistry } from './agents-config'
import type { AgentDeclaration, AgentsRegistry } from './agents-config'
import type { AgentProbeResult, AgentRuntimeAdapter } from './types'
import { probeHermesProfileGateway } from './hermes-gateway-probe'
import {
  AgoraxManagedAgentBridge,
  type AgoraxManagedAgentTransport,
  isAgoraxManagedAgentBackend,
} from './agorax-managed-agent-bridge'
import { createAgoraxManagedAgentTransportFromEnv } from './agorax-managed-agent-transport'

/** Read-only stand-in for hermes-runtime agents (they are not spawned here). */
class HermesAdapterStub implements AgentRuntimeAdapter {
  readonly kind = 'hermes' as const
  constructor(private readonly decl: AgentDeclaration) {}
  async probe(): Promise<AgentProbeResult> {
    const profile = (this.decl.profile || this.decl.id).trim() || 'default'
    return probeHermesProfileGateway(profile)
  }
  async startRun(): Promise<{ runId: string }> {
    throw new Error(
      'hermes runtime is dispatched via the existing swarm-dispatch path, not AgentRuntime',
    )
  }
  streamEvents(): AsyncIterable<never> {
    throw new Error('hermes runtime has no managed stream')
  }
  async interrupt(): Promise<void> {
    throw new Error('hermes runtime is interrupted via the existing swarm path')
  }
}

const UNSUPPORTED_RUNTIMES = new Set(['deepseek-harness'])

/** Adapter slot for declared runtimes whose adapter ships in a later step. */
class UnavailableAdapter implements AgentRuntimeAdapter {
  constructor(
    private readonly decl: AgentDeclaration,
    private readonly unavailableDetail = `adapter for ${decl.runtime} not yet delivered (P1 步骤 4)`,
  ) {}
  get kind() {
    return this.decl.runtime
  }
  async probe(): Promise<AgentProbeResult> {
    return {
      available: false,
      detail: this.unavailableDetail,
    }
  }
  async startRun(): Promise<{ runId: string }> {
    throw new Error(`adapter for ${this.decl.runtime} not yet delivered`)
  }
  streamEvents(): AsyncIterable<never> {
    throw new Error(`adapter for ${this.decl.runtime} not yet delivered`)
  }
  async interrupt(): Promise<void> {}
}

type ProbeAllRow = {
  agentId: string
  runtime: string
  execution: string
} & AgentProbeResult

/** Coalesce concurrent /api/agents polls onto one probeAll. */
const PROBE_ALL_CACHE_TTL_MS = 15_000

export class AgentRuntimeRouter {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>()
  readonly registry: AgentsRegistry
  private probeAllCache: { at: number; rows: Array<ProbeAllRow> } | null = null
  private probeAllInflight: Promise<Array<ProbeAllRow>> | null = null

  constructor(input?: {
    repoRoot?: string
    rawYaml?: string
    agoraxManagedTransport?: AgoraxManagedAgentTransport
  }) {
    const agoraxManagedTransport =
      input?.agoraxManagedTransport ??
      createAgoraxManagedAgentTransportFromEnv() ??
      undefined
    this.registry = loadAgentsRegistry(input)
    for (const decl of this.registry.agents) {
      this.adapters.set(
        decl.id,
        this.buildAdapter(decl, agoraxManagedTransport),
      )
    }
  }

  private buildAdapter(
    decl: AgentDeclaration,
    agoraxManagedTransport?: AgoraxManagedAgentTransport,
  ): AgentRuntimeAdapter {
    switch (decl.runtime) {
      case 'hermes':
        return new HermesAdapterStub(decl)
      case 'claude-code':
      case 'codex':
      case 'cursor':
      case 'kimi':
      case 'opencode':
        if (
          agoraxManagedTransport &&
          isAgoraxManagedAgentBackend(decl.runtime)
        ) {
          return new AgoraxManagedAgentBridge(
            decl.runtime,
            agoraxManagedTransport,
          )
        }
        return new UnavailableAdapter(
          decl,
          'Agorax Managed Agent transport is not configured',
        )
      default:
        if (UNSUPPORTED_RUNTIMES.has(decl.runtime)) {
          return new UnavailableAdapter(decl)
        }
        throw new Error(`No adapter for runtime ${decl.runtime}`)
    }
  }

  getAdapter(agentId: string): AgentRuntimeAdapter | null {
    return this.adapters.get(agentId) ?? null
  }

  /** Drop probeAll memo (tests / after registry rebuild). */
  clearProbeAllCache(): void {
    this.probeAllCache = null
    this.probeAllInflight = null
  }

  async probeAll(options?: { fresh?: boolean }): Promise<Array<ProbeAllRow>> {
    const fresh = options?.fresh === true
    if (
      !fresh &&
      this.probeAllCache &&
      Date.now() - this.probeAllCache.at < PROBE_ALL_CACHE_TTL_MS
    ) {
      return this.probeAllCache.rows
    }
    // Stale-while-revalidate: serve the last snapshot immediately and refresh
    // in the background so GET /api/agents stays off the slow probe path.
    if (!fresh && this.probeAllCache && !this.probeAllInflight) {
      void this.refreshProbeAll()
      return this.probeAllCache.rows
    }
    if (this.probeAllInflight) {
      if (!fresh && this.probeAllCache) return this.probeAllCache.rows
      return this.probeAllInflight
    }
    return this.refreshProbeAll()
  }

  private refreshProbeAll(): Promise<Array<ProbeAllRow>> {
    // Probe in parallel — sequential health checks stall /api/agents/status
    // when several profile gateways are down (each waits the fetch timeout).
    this.probeAllInflight = Promise.all(
      this.registry.agents.map(async (decl) => {
        const adapter = this.adapters.get(decl.id)
        if (!adapter) {
          return {
            agentId: decl.id,
            runtime: decl.runtime,
            execution: decl.execution,
            available: false,
            detail: 'no adapter',
          }
        }
        let probe: AgentProbeResult
        try {
          probe = await adapter.probe()
        } catch (error) {
          probe = {
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          }
        }
        return {
          agentId: decl.id,
          runtime: decl.runtime,
          execution: decl.execution,
          ...probe,
        }
      }),
    )
      .then((rows) => {
        this.probeAllCache = { at: Date.now(), rows }
        return rows
      })
      .finally(() => {
        this.probeAllInflight = null
      })

    return this.probeAllInflight
  }
}

// ─── Singleton (HMR-safe via globalThis) ────────────────────────────────

const ROUTER_KEY = '__agent_runtime_router__' as const

export function getAgentRuntimeRouter(): AgentRuntimeRouter {
  const g = globalThis as Record<string, unknown>
  // HMR: this module calls resetAgentRuntimeRouter() on
  // dispose so the next access rebuilds with fresh bridge code. Do not
  // reconstruct on every request — that would drop in-flight run lookups and
  // waste parse work on the hot chat path.
  if (!g[ROUTER_KEY]) {
    g[ROUTER_KEY] = new AgentRuntimeRouter()
  }
  return g[ROUTER_KEY] as AgentRuntimeRouter
}

/** Drop the cached router (tests + HMR). */
export function resetAgentRuntimeRouter(): void {
  const g = globalThis as Record<string, unknown>
  delete g[ROUTER_KEY]
}

/** Test hook: replace the singleton. */
export function setAgentRuntimeRouterForTests(
  router: AgentRuntimeRouter | null,
): void {
  const g = globalThis as Record<string, unknown>
  if (router) g[ROUTER_KEY] = router
  else delete g[ROUTER_KEY]
}

if (import.meta.hot) {
  // Force this module to re-apply on edit; dispose drops the singleton so the
  // next getAgentRuntimeRouter() rebuilds managed bridges with fresh code.
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    resetAgentRuntimeRouter()
  })
}
