/**
 * East-Asian IME Enter detection.
 *
 * Safari (and some Chromium builds) fire the committing Enter *after*
 * `compositionend` with `isComposing === false`. Relying on `isComposing`
 * alone lets that trailing Enter submit the composer. Mirror the Hermes
 * WebUI guard: treat keyCode 229 as still-composing, and keep a short
 * post-compositionend flag that clears on the next macrotask / blur.
 */

export type ImeKeyLike = {
  isComposing?: boolean
  keyCode?: number
  which?: number
}

export function isImeKeyEvent(
  event: ImeKeyLike,
  composingFlag = false,
): boolean {
  return (
    Boolean(event.isComposing) ||
    event.keyCode === 229 ||
    event.which === 229 ||
    composingFlag
  )
}

/** Call from compositionend; returns a cancel fn for the deferred clear. */
export function scheduleImeComposingClear(
  clear: () => void,
): () => void {
  const id = window.setTimeout(clear, 0)
  return () => window.clearTimeout(id)
}
