type TurnControl = {
  signal: AbortSignal
  isCanceled: () => boolean
  bindCancel: (cancel: () => Promise<unknown>) => void
  finish: () => void
  cancel: () => Promise<void>
}

const controlGlobal = globalThis as typeof globalThis & { __agoraxRoomTurnControls?: Map<string, Set<TurnControl>> }
const controls = controlGlobal.__agoraxRoomTurnControls ??= new Map<string, Set<TurnControl>>()

export function registerRoomTurn(roomId: string): TurnControl {
  const controller = new AbortController()
  let cancelTarget: (() => Promise<unknown>) | null = null
  let cancellation: Promise<unknown> | null = null
  let finished = false
  let finishing = false
  let resolveFinished!: () => void
  const failureListeners = new Set<(error: unknown) => void>()
  const settled = new Promise<void>((resolve) => { resolveFinished = resolve })
  const complete = () => {
    if (finished) return
    finished = true
    controls.get(roomId)?.delete(control)
    if (controls.get(roomId)?.size === 0) controls.delete(roomId)
    resolveFinished()
  }
  const invokeCancel = () => {
    if (!cancelTarget || cancellation || finished) return
    cancellation = Promise.resolve().then(cancelTarget)
    void cancellation.then(() => { if (finishing) complete() }, () => undefined)
    void cancellation.catch((error: unknown) => {
      cancellation = null
      for (const reject of failureListeners) reject(error)
    })
  }
  const control: TurnControl = {
    signal: controller.signal,
    isCanceled: () => controller.signal.aborted,
    bindCancel(cancel) {
      cancelTarget = cancel
      if (controller.signal.aborted) invokeCancel()
    },
    finish() {
      finishing = true
      if (!controller.signal.aborted || !cancelTarget) complete()
      else if (cancellation) void cancellation.then(complete, () => undefined)
    },
    cancel() {
      let rejectFailure!: (error: unknown) => void
      const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
      failureListeners.add(rejectFailure)
      controller.abort()
      invokeCancel()
      return Promise.race([settled, failed]).finally(() => failureListeners.delete(rejectFailure))
    },
  }
  const roomControls = controls.get(roomId) ?? new Set<TurnControl>()
  roomControls.add(control)
  controls.set(roomId, roomControls)
  return control
}

export async function cancelRoomTurns(roomId: string, timeoutMs = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([...(controls.get(roomId) ?? [])].map((control) => control.cancel())),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Room turns are still stopping; retry Pause or Resume')), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function hasActiveRoomTurns(roomId: string): boolean {
  return (controls.get(roomId)?.size ?? 0) > 0
}