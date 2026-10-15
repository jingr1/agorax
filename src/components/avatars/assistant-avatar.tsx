import { memo } from 'react'
import { cn } from '@/lib/utils'
import { AgentIdentityAvatar } from './agent-identity-avatar'
import { useAssistantAvatarConfig } from './assistant-avatar-context'
import {
  normalizeAgentAvatarProvider,
  resolveAgentAvatarSrc,
} from '@/lib/agent-avatar'

type AvatarProps = {
  size?: number
  className?: string
  /** Override context / default Hermes portrait. */
  src?: string
  alt?: string
  /** Agent display name — drives the optional two-letter badge. */
  name?: string
  /** Runtime / provider id for circular base art. */
  runtime?: string | null
  providerSiblingCount?: number
  showInitials?: boolean
}

/**
 * Assistant avatar — circular provider art. Claude Code / Codex hosts
 * wrap the tree with AssistantAvatarProvider, or pass runtime/name directly.
 */
function AssistantAvatarComponent({
  size = 28,
  className,
  src,
  alt,
  name,
  runtime,
  providerSiblingCount,
  showInitials,
}: AvatarProps) {
  const fromContext = useAssistantAvatarConfig()
  const resolvedAlt = alt ?? fromContext.alt
  const resolvedName = name ?? fromContext.alt

  if (runtime || name !== undefined || showInitials !== undefined) {
    return (
      <AgentIdentityAvatar
        name={resolvedName}
        runtime={runtime ?? inferRuntimeFromSrc(src ?? fromContext.src)}
        providerSiblingCount={providerSiblingCount}
        showInitials={showInitials}
        size={size}
        className={className}
        alt={resolvedAlt}
      />
    )
  }

  const resolvedSrc = src ?? fromContext.src
  const inferredRuntime = inferRuntimeFromSrc(resolvedSrc)

  return (
    <AgentIdentityAvatar
      name={resolvedName}
      runtime={inferredRuntime}
      size={size}
      className={cn('shrink-0', className)}
      alt={resolvedAlt}
      presentation={{
        label: resolvedAlt,
        src:
          inferredRuntime === 'fallback' && resolvedSrc
            ? resolvedSrc
            : resolveAgentAvatarSrc(inferredRuntime),
        provider: normalizeAgentAvatarProvider(inferredRuntime),
        initials: null,
      }}
    />
  )
}

function inferRuntimeFromSrc(src: string | undefined): string {
  if (!src) return 'hermes'
  if (src.includes('codex')) return 'codex'
  if (src.includes('claude')) return 'claude-code'
  if (src.includes('cursor')) return 'cursor'
  if (src.includes('opencode')) return 'opencode'
  if (src.includes('agorax')) return 'agorax'
  if (src.includes('hermes')) return 'hermes'
  if (src.includes('agent-avatars/')) {
    const file = src.split('/').pop()?.replace(/-rounded\.png$/i, '') ?? ''
    return file || 'fallback'
  }
  return 'hermes'
}

export const AssistantAvatar = memo(AssistantAvatarComponent)
