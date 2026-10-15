/**
 * Hermes native bridge — Phase 0–1 skeleton.
 *
 * Dual-bridge contract: see docs/hermes-native-bridge.md.
 * This module does NOT replace HermesAdapterStub, send-stream, or tmux /
 * swarm-dispatch. It defines the identity mapping and documents how
 * gateway send-stream maps onto Session/Turn for a future activity adapter.
 */

export type HermesNativeBridgeKind = 'hermes-native'

/**
 * Durable mapping row: Agorax Session/Turn ↔ Hermes gateway / swarm ids.
 * Persistence owner is Workspace-side (collab.db or a dedicated table);
 * this type is the contract only.
 */
export type AgoraxRunMapping = {
  agentSessionId: string
  turnId: string | null
  gatewaySessionId: string | null
  assignmentId: string | null
  hermesRunId: string | null
  bridgeKind: HermesNativeBridgeKind
  updatedAtUnixMs: number
}

export type HermesNativeCreateSessionInput = {
  agentSessionId: string
  /** Optional existing gateway session to attach; empty → probe/create later. */
  gatewaySessionId?: string | null
  cwd?: string | null
  model?: string | null
}

export type HermesNativeCreateSessionResult = {
  mapping: AgoraxRunMapping
  /**
   * Phase 1: always `pending_gateway` until a real gateway Create is wired.
   * Callers must not treat this as a live managed daemon session.
   */
  status: 'pending_gateway' | 'attached'
  detail: string
}

export type HermesNativeSendInput = {
  agentSessionId: string
  turnId: string
  clientSubmitId: string
  content: string
  /** When set, send-stream should reuse this gateway session. */
  gatewaySessionId?: string | null
}

export type HermesNativeSendResult = {
  mapping: AgoraxRunMapping
  /**
   * Documents the intended send-stream mapping without invoking it:
   *   Create/attach gateway session → POST /api/send-stream (or gateway chat)
   *   → stream events project to Turn message_delta / tool / settle.
   */
  status: 'stubbed'
  detail: string
}

export type HermesNativeBridgeOptions = {
  /** Optional probe of gateway reachability; unused by stubs. */
  gatewayBaseUrl?: string | null
  nowUnixMs?: () => number
}

/**
 * Phase 0–1 skeleton. Create/Send return honest stubs that record the mapping
 * shape and describe how send-stream becomes Session/Turn. They never claim
 * provider success and never touch tmux.
 */
export class HermesNativeBridge {
  private readonly nowUnixMs: () => number
  private readonly mappings = new Map<string, AgoraxRunMapping>()

  constructor(private readonly options: HermesNativeBridgeOptions = {}) {
    this.nowUnixMs = options.nowUnixMs ?? (() => Date.now())
  }

  getMapping(agentSessionId: string): AgoraxRunMapping | null {
    return this.mappings.get(agentSessionId.trim()) ?? null
  }

  /**
   * Phase 1 stub: allocate / refresh an `agorax_run_mapping` row. A later
   * iteration opens or resumes a Hermes gateway session and fills
   * `gatewaySessionId`.
   */
  async createSession(
    input: HermesNativeCreateSessionInput,
  ): Promise<HermesNativeCreateSessionResult> {
    const agentSessionId = input.agentSessionId.trim()
    if (!agentSessionId) {
      throw new Error('hermes native bridge createSession requires agentSessionId')
    }
    const mapping: AgoraxRunMapping = {
      agentSessionId,
      turnId: null,
      gatewaySessionId: input.gatewaySessionId?.trim() || null,
      assignmentId: null,
      hermesRunId: null,
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: this.nowUnixMs(),
    }
    this.mappings.set(agentSessionId, mapping)
    return {
      mapping,
      status: mapping.gatewaySessionId ? 'attached' : 'pending_gateway',
      detail:
        'Hermes native bridge Phase 1 stub: mapping recorded; gateway Create/Send not yet wired. Existing Hermes chat continues via /api/send-stream.',
    }
  }

  /**
   * Phase 1 stub documenting the send-stream → Turn path:
   *
   * 1. Resolve `agorax_run_mapping` for `agentSessionId`.
   * 2. Ensure gateway session (`gatewaySessionId`).
   * 3. POST send-stream with the user content; capture `hermesRunId`.
   * 4. Stream chunks → activity message_delta / tool events on `turnId`.
   * 5. Terminal / abort → settle Turn (cancel uses gateway abort, never tmux C-c).
   *
   * This stub only updates the in-memory mapping and returns `stubbed`.
   */
  async sendInput(
    input: HermesNativeSendInput,
  ): Promise<HermesNativeSendResult> {
    const agentSessionId = input.agentSessionId.trim()
    const turnId = input.turnId.trim()
    if (!agentSessionId || !turnId || !input.clientSubmitId.trim()) {
      throw new Error(
        'hermes native bridge sendInput requires agentSessionId, turnId, and clientSubmitId',
      )
    }
    const existing = this.mappings.get(agentSessionId)
    const mapping: AgoraxRunMapping = {
      agentSessionId,
      turnId,
      gatewaySessionId:
        input.gatewaySessionId?.trim() ||
        existing?.gatewaySessionId ||
        null,
      assignmentId: existing?.assignmentId ?? null,
      hermesRunId: existing?.hermesRunId ?? null,
      bridgeKind: 'hermes-native',
      updatedAtUnixMs: this.nowUnixMs(),
    }
    this.mappings.set(agentSessionId, mapping)
    return {
      mapping,
      status: 'stubbed',
      detail:
        'Hermes native bridge Phase 1 stub: send-stream not invoked. Map turnId→gateway session, stream via /api/send-stream, then settle Turn on terminal/abort.',
    }
  }

  /**
   * Cancel contract reminder: gateway abort + canonical settle only.
   * Never send C-c into a Hermes TUI tmux pane from this bridge.
   */
  cancelPolicy(): {
    allowTmuxControlC: false
    mechanism: 'gateway-abort-and-settle'
  } {
    return {
      allowTmuxControlC: false,
      mechanism: 'gateway-abort-and-settle',
    }
  }
}

/** Probe helper for tests / future wiring — does not start a bridge session. */
export function hermesNativeBridgeIsStubOnly(): true {
  return true
}
