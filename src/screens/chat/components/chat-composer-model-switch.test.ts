import { describe, expect, it } from 'vitest'
import {
  MODEL_SWITCH_BLOCKED_TOAST,
  getZeroForkModelInfoFlags,
  isModelSwitcherEnabled,
  isRuntimeCapabilityAllowed,
  shouldBlockZeroForkModelSwitch,
} from './chat-composer-model-switch'

describe('isRuntimeCapabilityAllowed', () => {
  it('allows model switch when capabilities are unknown (Hermes or loading managed)', () => {
    expect(isRuntimeCapabilityAllowed(undefined, 'modelSwitch')).toBe(true)
    expect(isRuntimeCapabilityAllowed(null, 'modelSwitch')).toBe(true)
  })

  it('only disables when the capability is explicitly false', () => {
    expect(
      isRuntimeCapabilityAllowed({ modelSwitch: true } as never, 'modelSwitch'),
    ).toBe(true)
    expect(
      isRuntimeCapabilityAllowed(
        { modelSwitch: false } as never,
        'modelSwitch',
      ),
    ).toBe(false)
  })

  it('applies the same null-vs-false gate to imageInput', () => {
    expect(isRuntimeCapabilityAllowed(null, 'imageInput')).toBe(true)
    expect(
      isRuntimeCapabilityAllowed({ imageInput: false } as never, 'imageInput'),
    ).toBe(false)
  })
})

describe('isModelSwitcherEnabled', () => {
  it('stays enabled when a catalog exists even if modelSwitch was omitted as false', () => {
    expect(
      isModelSwitcherEnabled({ modelSwitch: false } as never, 3),
    ).toBe(true)
  })

  it('disables only when modelSwitch is false and the catalog is empty', () => {
    expect(
      isModelSwitcherEnabled({ modelSwitch: false } as never, 0),
    ).toBe(false)
  })
})

describe('zero-fork model switch guard', () => {
  it('blocks picker swaps only for zero-fork vanilla agents', () => {
    expect(
      shouldBlockZeroForkModelSwitch('zero-fork', {
        vanillaAgent: true,
        supportsRuntimeSwitching: false,
      }),
    ).toBe(true)

    expect(
      shouldBlockZeroForkModelSwitch('enhanced-fork', {
        vanillaAgent: true,
        supportsRuntimeSwitching: false,
      }),
    ).toBe(false)

    expect(
      shouldBlockZeroForkModelSwitch('zero-fork', {
        vanillaAgent: false,
        supportsRuntimeSwitching: true,
      }),
    ).toBe(false)
  })

  it('infers vanilla zero-fork agents from realistic dashboard payloads', () => {
    const flags = getZeroForkModelInfoFlags({
      model: 'gpt-5.4',
      provider: 'openai-codex',
      capabilities: {
        supports_tools: true,
      },
    })

    expect(flags).toEqual({
      vanillaAgent: true,
      supportsRuntimeSwitching: false,
    })
    expect(shouldBlockZeroForkModelSwitch('zero-fork', flags)).toBe(true)
  })

  it('keeps the toast copy stable', () => {
    expect(MODEL_SWITCH_BLOCKED_TOAST).toBe(
      'Model switching requires the enhanced runtime. Set a default via `claude config set model <id>` — the displayed model reflects your config.',
    )
  })
})
