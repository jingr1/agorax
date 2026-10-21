import { beforeEach, describe, expect, it } from 'vitest'
import {
  canDrainQueuedFollowUp,
  isChatTurnBusyGateOpen,
} from './chat-turn-busy-gate'
import {
  __resetRememberedOpenTurnForTests,
  rememberOpenTurn,
} from './engine-user-prompt-ingest'

describe('isChatTurnBusyGateOpen', () => {
  beforeEach(() => {
    __resetRememberedOpenTurnForTests()
  })

  it('opens for turnBusy / streaming / sending', () => {
    expect(isChatTurnBusyGateOpen({ turnBusy: true })).toBe(true)
    expect(isChatTurnBusyGateOpen({ localIsStreaming: true })).toBe(true)
    expect(isChatTurnBusyGateOpen({ sending: true })).toBe(true)
  })

  it('opens while Engine active turn is not settled', () => {
    expect(isChatTurnBusyGateOpen({ activeTurnPhase: 'running' })).toBe(true)
    expect(isChatTurnBusyGateOpen({ activeTurnPhase: 'settling' })).toBe(true)
    expect(isChatTurnBusyGateOpen({ activeTurnPhase: 'settled' })).toBe(false)
  })

  it('opens while open-turn nonce is remembered', () => {
    rememberOpenTurn({
      agentSessionId: 'sess-1',
      clientSubmitId: 'c1',
      turnId: 'turn-c1',
    })
    expect(isChatTurnBusyGateOpen({ agentSessionId: 'sess-1' })).toBe(true)
    expect(isChatTurnBusyGateOpen({ agentSessionId: 'sess-other' })).toBe(false)
  })

  it('stays closed when idle', () => {
    expect(isChatTurnBusyGateOpen({})).toBe(false)
  })
})

describe('canDrainQueuedFollowUp', () => {
  beforeEach(() => {
    __resetRememberedOpenTurnForTests()
  })

  it('refuses drain until a busy→idle edge and gate is closed', () => {
    expect(
      canDrainQueuedFollowUp({
        wasBusy: false,
        turnBusy: false,
      }),
    ).toBe(false)
    expect(
      canDrainQueuedFollowUp({
        wasBusy: true,
        turnBusy: true,
      }),
    ).toBe(false)
    expect(
      canDrainQueuedFollowUp({
        wasBusy: true,
        activeTurnPhase: 'settling',
      }),
    ).toBe(false)
  })

  it('allows drain after busy when settled and no remembered open turn', () => {
    expect(
      canDrainQueuedFollowUp({
        wasBusy: true,
        turnBusy: false,
        activeTurnPhase: 'settled',
      }),
    ).toBe(true)
  })
})
