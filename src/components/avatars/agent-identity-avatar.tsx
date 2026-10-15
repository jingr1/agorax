import { cn } from '@/lib/utils'
import {
  projectAgentIdentityAvatar,
  type AgentIdentityAvatarPresentation,
} from '@/lib/agent-avatar'

export type AgentIdentityAvatarProps = {
  name: string
  runtime?: string | null
  /** How many agents share this provider; >1 shows the two-letter badge. */
  providerSiblingCount?: number
  /** Force initials badge; overrides sibling-count heuristic. */
  showInitials?: boolean
  /** Pixel edge length of the circular frame. */
  size?: number
  className?: string
  /** Optional precomputed presentation (skips projection). */
  presentation?: AgentIdentityAvatarPresentation
  alt?: string
}

function badgeFontSize(size: number): number {
  if (size <= 24) return 7
  if (size <= 32) return 8
  if (size <= 40) return 9
  return Math.max(10, Math.round(size * 0.22))
}

function badgeEdge(size: number): number {
  if (size <= 24) return Math.max(12, Math.round(size * 0.55))
  if (size <= 40) return Math.max(14, Math.round(size * 0.48))
  return Math.max(16, Math.round(size * 0.42))
}

/**
 * Circular agent identity avatar: provider base art + optional two-letter
 * initials badge when the provider owns multiple agents.
 */
export function AgentIdentityAvatar({
  name,
  runtime,
  providerSiblingCount,
  showInitials,
  size = 32,
  className,
  presentation: presentationOverride,
  alt,
}: AgentIdentityAvatarProps) {
  const presentation =
    presentationOverride ??
    projectAgentIdentityAvatar({
      name,
      runtime,
      providerSiblingCount,
      showInitials,
    })

  const badgeSize = badgeEdge(size)
  const label = alt ?? presentation.label

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 overflow-visible rounded-full',
        className,
      )}
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        presentation.initials
          ? `${label} (${presentation.initials})`
          : label
      }
      data-agent-identity-avatar={presentation.provider}
      data-agent-identity-initials={presentation.initials ?? undefined}
    >
      <span
        data-avatar-clip=""
        className={cn(
          'absolute inset-0 overflow-hidden rounded-full',
          // Static edge ring only when not busy-pulsing (parent adds
          // thinking-avatar-glow → inset pulse on this same clip).
          !String(className ?? '').includes('thinking-avatar-glow') &&
            'ring-1 ring-black/5',
        )}
      >
        <img
          src={presentation.src}
          alt=""
          aria-hidden
          className="size-full object-cover"
          draggable={false}
        />
      </span>
      {presentation.initials ? (
        <span
          aria-hidden
          className="absolute z-10 flex items-center justify-center rounded-full bg-neutral-950/90 font-semibold tracking-tight text-white shadow-sm ring-2 ring-[var(--theme-bg,white)]"
          style={{
            width: badgeSize,
            height: badgeSize,
            fontSize: badgeFontSize(size),
            lineHeight: 1,
            right: -Math.round(badgeSize * 0.12),
            bottom: -Math.round(badgeSize * 0.12),
          }}
        >
          {presentation.initials}
        </span>
      ) : null}
    </span>
  )
}
