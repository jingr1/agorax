export type StreamHandoffHandler = () => Promise<boolean>

let handoffHandler: StreamHandoffHandler | null = null

export function registerStreamHandoffHandler(
  handler: StreamHandoffHandler | null,
): void {
  handoffHandler = handler
}

export async function requestStreamHandoffIfActive(): Promise<boolean> {
  if (!handoffHandler) return false
  return handoffHandler()
}
