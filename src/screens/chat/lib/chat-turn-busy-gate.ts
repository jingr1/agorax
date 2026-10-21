/**
 * When the current turn is still open, a new user must not enter the Engine
 * list (composer should queue). Shared by composer busy chrome, send(), and
 * queue drain so they cannot disagree.
 */

import { getRememberedOpenTurn } from './engine-user-prompt-ingest'

export type ChatTurnBusyGateInput = {
  agentSessionId?: string | null
  /** Engine/list turnBusy (active turn or submitting overlay). */
  turnBusy?: boolean
  localIsStreaming?: boolean
  sending?: boolean
  activeTurnPhase?: string | null
  /** Open-turn nonce set at ingest — survives brief Engine activeTurn gaps. */
  rememberedOpenTurn?: boolean
}

export function hasRememberedOpenTurn(agentSessionId: string | null | undefined): boolean {
  const sid = agentSessionId?.trim() ?? ''
  return sid.length > 0 && getRememberedOpenTurn(sid) !== null
}

/**
 * True while a turn must block a new user row from entering the transcript.
 */
export function isChatTurnBusyGateOpen(input: ChatTurnBusyGateInput): boolean {
  if (input.turnBusy === true) return true
  if (input.localIsStreaming === true) return true
  if (input.sending === true) return true
  const phase = input.activeTurnPhase?.trim() ?? ''
  if (phase.length > 0 && phase !== 'settled') return true
  if (input.rememberedOpenTurn === true) return true
  if (hasRememberedOpenTurn(input.agentSessionId)) return true
  return false
}

/**
 * Queue drain may fire only after a busy→idle edge and the gate is fully open.
 */
export function canDrainQueuedFollowUp(input: ChatTurnBusyGateInput & {
  wasBusy: boolean
}): boolean {
  if (!input.wasBusy) return false
  return !isChatTurnBusyGateOpen(input)
}
