import { describe, expect, it } from 'vitest'
import {
  composerPrimaryActionLabel,
  getComposerPrimaryAction,
  resolveComposerBusyUi,
} from './composer-primary-action'

describe('getComposerPrimaryAction', () => {
  it('returns disabled when composer is locked', () => {
    expect(
      getComposerPrimaryAction({
        disabled: true,
        isBusy: false,
        hasContent: true,
      }),
    ).toBe('disabled')
  })

  it('returns send when idle with draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: false,
        hasContent: true,
      }),
    ).toBe('send')
  })

  it('returns stop when busy without draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: false,
      }),
    ).toBe('stop')
  })

  it('returns queue when busy with draft content (default mode)', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
      }),
    ).toBe('queue')
  })

  it('returns interrupt when busy mode is interrupt', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        busyMessageMode: 'interrupt',
      }),
    ).toBe('interrupt')
  })

  it('returns steer when busy mode is steer and canSteer', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        busyMessageMode: 'steer',
        canSteer: true,
      }),
    ).toBe('steer')
  })

  it('falls back to queue when steer mode but no live run', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        busyMessageMode: 'steer',
        canSteer: false,
      }),
    ).toBe('queue')
  })

  it('returns queue when compacting without draft content', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: false,
        hasContent: false,
        isCompacting: true,
      }),
    ).toBe('queue')
  })
  it('returns stop when busy with draft but no follow-up actions', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        hasBusyFollowUpActions: false,
      }),
    ).toBe('stop')
  })

  it('returns queue when busy with draft and follow-up actions enabled', () => {
    expect(
      getComposerPrimaryAction({
        disabled: false,
        isBusy: true,
        hasContent: true,
        hasBusyFollowUpActions: true,
      }),
    ).toBe('queue')
  })
})

describe('composerPrimaryActionLabel', () => {
  it('labels busy-mode actions', () => {
    expect(composerPrimaryActionLabel('stop')).toBe('Stop generation')
    expect(composerPrimaryActionLabel('queue')).toBe('Queue message')
    expect(composerPrimaryActionLabel('interrupt')).toBe('Interrupt and send')
    expect(composerPrimaryActionLabel('steer')).toBe('Steer current response')
    expect(composerPrimaryActionLabel('send')).toBe('Send message')
  })
})

describe('resolveComposerBusyUi', () => {
  it('keeps Stop usable when caller passes disabled during streaming', () => {
    const ui = resolveComposerBusyUi({
      disabled: true,
      isLoading: true,
      hasContent: false,
      hasDraft: false,
    })
    expect(ui.hardDisabled).toBe(false)
    expect(ui.primaryAction).toBe('stop')
    expect(ui.allowMicInsteadOfPrimary).toBe(false)
    expect(ui.placeholder).toContain('Stop')
  })

  it('allows mic only when idle and empty', () => {
    const ui = resolveComposerBusyUi({
      disabled: false,
      isLoading: false,
      hasContent: false,
      hasDraft: false,
    })
    expect(ui.primaryAction).toBe('disabled')
    expect(ui.allowMicInsteadOfPrimary).toBe(true)
    expect(ui.placeholder).toBe('Ask anything...')
  })

  it('uses Hermes busy copy when follow-up actions are wired', () => {
    const ui = resolveComposerBusyUi({
      disabled: false,
      isLoading: true,
      hasContent: false,
      hasDraft: false,
      hasBusyFollowUpActions: true,
      busyMessageMode: 'queue',
    })
    expect(ui.placeholder).toContain('/interrupt')
  })

  it('uses simple Stop copy for managed runtimes', () => {
    const ui = resolveComposerBusyUi({
      disabled: false,
      isLoading: true,
      hasContent: false,
      hasDraft: false,
      hasBusyFollowUpActions: false,
    })
    expect(ui.placeholder).toBe('Generating… click Stop to abort')
  })

  it('keeps Stop (not Queue) when managed user types while streaming', () => {
    const ui = resolveComposerBusyUi({
      disabled: false,
      isLoading: true,
      hasContent: true,
      hasDraft: true,
      hasBusyFollowUpActions: false,
    })
    expect(ui.primaryAction).toBe('stop')
    expect(ui.hardDisabled).toBe(false)
  })
})
