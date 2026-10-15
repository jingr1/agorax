/**
 * Room runtime coercion — shared by participants API and heal.
 * Kept separate from `types.ts` so client type re-exports stay type-only.
 */
import { isAgoraxManagedAgentBackend } from '@/lib/managed-agent-runtime/agent-targets'
import type { RoomRuntime } from './types'

export function isRoomAgentRuntime(
  value: string,
): value is Exclude<RoomRuntime, 'human'> {
  return (
    value === 'hermes' ||
    value === 'deepseek-harness' ||
    isAgoraxManagedAgentBackend(value)
  )
}

/** Coerce a free-form runtime string; unknown values return null. */
export function coerceRoomRuntime(
  value: string | null | undefined,
): RoomRuntime | null {
  const key = value?.trim().toLowerCase() ?? ''
  if (!key) return null
  if (key === 'human') return 'human'
  if (isRoomAgentRuntime(key)) return key
  return null
}

/** Non-Hermes agent runtimes never carry a Hermes profile. */
export function isManagedRoomRuntime(runtime: RoomRuntime): boolean {
  return runtime !== 'hermes' && runtime !== 'human'
}
