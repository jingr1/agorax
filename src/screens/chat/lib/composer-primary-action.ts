export type BusyMessageMode = 'queue' | 'interrupt' | 'steer'

export type ComposerPrimaryAction =
  | 'send'
  | 'stop'
  | 'queue'
  | 'interrupt'
  | 'steer'
  | 'disabled'

export function getComposerPrimaryAction(options: {
  disabled: boolean
  isBusy: boolean
  hasContent: boolean
  isCompacting?: boolean
  busyMessageMode?: BusyMessageMode
  /** True when a live run id is available for mid-turn steer */
  canSteer?: boolean
  /**
   * When false (managed runtimes without onQueue/onSteer/onInterrupt),
   * busy state always exposes Stop — never Queue/Steer/Interrupt.
   * Defaults to true so Hermes callers keep existing behavior.
   */
  hasBusyFollowUpActions?: boolean
}): ComposerPrimaryAction {
  const {
    disabled,
    isBusy,
    hasContent,
    isCompacting = false,
    busyMessageMode = 'queue',
    canSteer = false,
    hasBusyFollowUpActions = true,
  } = options
  if (disabled) return 'disabled'

  const busy = isBusy || isCompacting
  if (!busy) return hasContent ? 'send' : 'disabled'

  // Managed / no follow-up wiring: Stop is the only busy primary control,
  // even if the user typed a draft while streaming.
  if (!hasBusyFollowUpActions) {
    if (isBusy) return 'stop'
    // Compacting without a follow-up handler — keep the field usable.
    return hasContent ? 'send' : 'disabled'
  }

  // Busy with a draft → mode-dependent primary action (Hermes).
  if (hasContent) {
    if (busyMessageMode === 'steer') return canSteer ? 'steer' : 'queue'
    if (busyMessageMode === 'interrupt') return 'interrupt'
    return 'queue'
  }

  if (isBusy) return 'stop'
  if (isCompacting) return 'queue'
  return 'disabled'
}

export function composerPrimaryActionLabel(
  action: ComposerPrimaryAction,
): string {
  switch (action) {
    case 'stop':
      return 'Stop generation'
    case 'queue':
      return 'Queue message'
    case 'interrupt':
      return 'Interrupt and send'
    case 'steer':
      return 'Steer current response'
    case 'send':
      return 'Send message'
    default:
      return 'Type a message to send'
  }
}

export type ComposerBusyUi = {
  /**
   * Hard lock for PromptInput / form controls.
   * False while streaming so the red Stop control stays usable even if a
   * caller mistakenly passes disabled={isLoading}.
   */
  hardDisabled: boolean
  primaryAction: ComposerPrimaryAction
  /**
   * When true, the mic may replace the primary button (caller still checks
   * mic availability). Never true while streaming — Stop must stay visible.
   */
  allowMicInsteadOfPrimary: boolean
  placeholder: string
}

/**
 * Shared Stop / busy interaction state for ChatComposer (Hermes + managed).
 * UI stays in ComposerPrimaryButton; this owns the decision rules.
 */
export function resolveComposerBusyUi(options: {
  disabled: boolean
  isLoading: boolean
  isCompacting?: boolean
  /** Includes in-flight attachments — drives primary send/stop/queue. */
  hasContent: boolean
  /** Draft text/files only — drives busy placeholder copy. */
  hasDraft: boolean
  busyMessageMode?: BusyMessageMode
  canSteer?: boolean
  /** True when onQueue / onSteer / onInterruptSend are wired (Hermes). */
  hasBusyFollowUpActions?: boolean
  isMobile?: boolean
  idlePlaceholder?: string
  idlePlaceholderMobile?: string
}): ComposerBusyUi {
  const {
    disabled,
    isLoading,
    isCompacting = false,
    hasContent,
    hasDraft,
    busyMessageMode = 'queue',
    canSteer = false,
    hasBusyFollowUpActions = false,
    isMobile = false,
    idlePlaceholder = 'Ask anything...',
    idlePlaceholderMobile = 'Message...',
  } = options

  const hardDisabled = Boolean(disabled && !isLoading)
  const primaryAction = getComposerPrimaryAction({
    disabled: hardDisabled,
    isBusy: isLoading,
    hasContent,
    isCompacting,
    busyMessageMode,
    canSteer,
    hasBusyFollowUpActions,
  })

  const allowMicInsteadOfPrimary =
    !isLoading && primaryAction === 'disabled'

  const placeholder = resolveBusyPlaceholder({
    isLoading,
    isCompacting,
    hasDraft,
    hasBusyFollowUpActions,
    busyMessageMode,
    isMobile,
    idlePlaceholder,
    idlePlaceholderMobile,
  })

  return {
    hardDisabled,
    primaryAction,
    allowMicInsteadOfPrimary,
    placeholder,
  }
}

function resolveBusyPlaceholder(options: {
  isLoading: boolean
  isCompacting: boolean
  hasDraft: boolean
  hasBusyFollowUpActions: boolean
  busyMessageMode: BusyMessageMode
  isMobile: boolean
  idlePlaceholder: string
  idlePlaceholderMobile: string
}): string {
  const {
    isLoading,
    isCompacting,
    hasDraft,
    hasBusyFollowUpActions,
    busyMessageMode,
    isMobile,
    idlePlaceholder,
    idlePlaceholderMobile,
  } = options

  if (!(isLoading || isCompacting) || hasDraft) {
    return isMobile ? idlePlaceholderMobile : idlePlaceholder
  }

  if (!hasBusyFollowUpActions) {
    return isMobile
      ? 'Generating… empty = stop'
      : 'Generating… click Stop to abort'
  }

  if (isMobile) {
    if (busyMessageMode === 'steer') return 'Enter = steer · empty = stop'
    if (busyMessageMode === 'interrupt')
      return 'Enter = interrupt · empty = stop'
    return 'Enter = queue · empty = stop'
  }

  if (busyMessageMode === 'steer') {
    return 'Enter steers the live reply · empty Stop · /queue /interrupt'
  }
  if (busyMessageMode === 'interrupt') {
    return 'Enter interrupts and sends · empty Stop · /queue /steer'
  }
  return 'Enter queues a follow-up · empty Stop · /interrupt /steer'
}
