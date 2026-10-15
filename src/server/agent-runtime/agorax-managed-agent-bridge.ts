import type {
  AgentProbeResult,
  AgentRunInput,
  AgentStreamEvent,
  McpHandshake,
} from './types'
import {
  AGORAX_MANAGED_AGENT_BACKENDS,
  isAgoraxManagedAgentBackend,
  type AgoraxManagedAgentBackend,
} from '@/lib/managed-agent-runtime/agent-targets'

export {
  AGORAX_MANAGED_AGENT_BACKENDS,
  isAgoraxManagedAgentBackend,
  type AgoraxManagedAgentBackend,
}

export type AgoraxManagedAgentTransport = {
  probe: (
    backend: AgoraxManagedAgentBackend,
  ) => Promise<AgentProbeResult>
  startRun: (input: {
    backend: AgoraxManagedAgentBackend
    run: AgentRunInput
    mcp: McpHandshake
  }) => Promise<{ runId: string }>
  streamEvents: (input: {
    backend: AgoraxManagedAgentBackend
    runId: string
  }) => AsyncIterable<AgentStreamEvent>
  interrupt: (input: {
    backend: AgoraxManagedAgentBackend
    runId: string
    reason: string
  }) => Promise<void>
}

/** Minimal surface the fallback needs (matches AgentRuntimeAdapter). */
type FallbackRunAdapter = {
  probe: () => Promise<AgentProbeResult>
  startRun: (
    input: AgentRunInput & { mcp: McpHandshake },
  ) => Promise<{ runId: string }>
  streamEvents: (runId: string) => AsyncIterable<AgentStreamEvent>
  interrupt: (runId: string, reason: string) => Promise<void>
}

const PROBE_CACHE_MS = 15_000

/**
 * Adapter boundary for the Agorax Managed Agent runtime backed by the embedded
 * Agorax Host/runtime implementation.
 *
 * This class deliberately owns no process, session, or turn state. The
 * transport must delegate those operations to the Agorax managed-agent Host runtime.
 */
export class AgoraxManagedAgentBridge {
  readonly kind: AgoraxManagedAgentBackend
  private readonly fallback: FallbackRunAdapter | null
  private readonly fallbackRunIds = new Set<string>()
  private probeCache: { at: number; result: AgentProbeResult } | null = null
  private probeInflight: Promise<AgentProbeResult> | null = null

  constructor(
    private readonly backend: AgoraxManagedAgentBackend,
    private readonly transport: AgoraxManagedAgentTransport,
    options?: { fallback?: FallbackRunAdapter | null },
  ) {
    this.kind = backend
    this.fallback = options?.fallback ?? null
  }

  /**
   * One transport.probe() per TTL window. The previous path called probe twice
   * on a cache miss (daemonAvailable + probe) and still re-fetched on a warm
   * hit — that multiplied /v1/agent-targets traffic under probeAll.
   */
  private async refreshProbe(): Promise<AgentProbeResult> {
    if (this.probeCache && Date.now() - this.probeCache.at < PROBE_CACHE_MS) {
      return this.probeCache.result
    }
    if (this.probeInflight) return this.probeInflight

    this.probeInflight = (async () => {
      let result: AgentProbeResult
      try {
        result = await this.transport.probe(this.backend)
      } catch (error) {
        result = {
          available: false,
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      this.probeCache = { at: Date.now(), result }
      return result
    })().finally(() => {
      this.probeInflight = null
    })
    return this.probeInflight
  }

  /** True when the daemon serves this backend's catalog target. */
  private async daemonAvailable(): Promise<boolean> {
    return (await this.refreshProbe()).available
  }

  async probe(): Promise<AgentProbeResult> {
    const result = await this.refreshProbe()
    if (result.available) return result
    if (this.fallback) return this.fallback.probe()
    return result
  }

  async startRun(
    input: AgentRunInput & { mcp: McpHandshake },
  ): Promise<{ runId: string }> {
    if (this.fallback && !(await this.daemonAvailable())) {
      const started = await this.fallback.startRun(input)
      this.fallbackRunIds.add(started.runId)
      return started
    }
    const { mcp, ...run } = input
    return this.transport.startRun({
      backend: this.backend,
      run,
      mcp,
    })
  }

  streamEvents(runId: string): AsyncIterable<AgentStreamEvent> {
    if (this.fallbackRunIds.has(runId)) {
      return this.fallback!.streamEvents(runId)
    }
    return this.transport.streamEvents({ backend: this.backend, runId })
  }

  async interrupt(runId: string, reason: string): Promise<void> {
    if (this.fallbackRunIds.has(runId)) {
      return this.fallback!.interrupt(runId, reason)
    }
    return this.transport.interrupt({
      backend: this.backend,
      runId,
      reason,
    })
  }
}