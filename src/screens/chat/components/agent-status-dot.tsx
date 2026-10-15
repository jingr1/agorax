import type { AgentStatus } from '@/lib/agent-types'
import type { AgentPresence } from '@/lib/agent-status'
import { presenceDotTone } from '@/lib/agent-status'
import { cn } from '@/lib/utils'

const TONE_STYLES = {
  online: 'bg-emerald-500',
  unstable: 'bg-amber-500',
  offline: 'bg-neutral-400 dark:bg-neutral-600',
  blocked: 'bg-rose-500',
  error: 'bg-red-500',
  needsSetup: 'bg-amber-400',
} as const

/** Legacy AgentStatus → approximate tone (only when presence is unavailable). */
const LEGACY_STATUS_STYLES: Record<AgentStatus, string> = {
  busy: TONE_STYLES.online,
  idle: 'bg-sky-400',
  online: 'bg-sky-400',
  offline: TONE_STYLES.offline,
  blocked: TONE_STYLES.blocked,
  unknown: TONE_STYLES.offline,
}

export function AgentStatusDot({
  status,
  presence,
  className,
  needsSetup,
  title,
  pulse,
}: {
  /** @deprecated Prefer `presence`. */
  status?: AgentStatus | string
  presence?: AgentPresence | null
  className?: string
  needsSetup?: boolean
  title?: string
  pulse?: boolean
}) {
  if (presence) {
    const tone = presenceDotTone(presence)
    const shouldPulse = pulse ?? tone.pulse
    return (
      <span
        className={cn(
          'inline-block size-2.5 shrink-0 rounded-full',
          TONE_STYLES[tone.tone],
          shouldPulse && 'animate-pulse',
          className,
        )}
        title={title ?? tone.title}
      />
    )
  }

  const style =
    (needsSetup ? TONE_STYLES.needsSetup : null) ??
    (status ? LEGACY_STATUS_STYLES[status as AgentStatus] : null) ??
    LEGACY_STATUS_STYLES.unknown

  return (
    <span
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        style,
        className,
      )}
      title={title ?? (needsSetup ? 'needs setup' : status)}
    />
  )
}
