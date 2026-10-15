import { HugeiconsIcon } from '@hugeicons/react'
import { motion } from 'motion/react'
import { AgentIdentityAvatar } from '@/components/avatars'
import type { AgentChatSuggestion } from '../agent-chat-brands'

type ChatEmptyStateProps = {
  /** Agent display name — the only identity copy in the empty state. */
  name: string
  /** Runtime / provider for the circular avatar base art. */
  runtime?: string | null
  suggestions?: Array<AgentChatSuggestion>
  onSuggestionClick?: (prompt: string) => void
  compact?: boolean
}

/**
 * New-session empty state: avatar + agent name + optional suggestion chips.
 * Format is shared across Hermes and managed runtimes; only name and avatar
 * differ per agent.
 */
export function ChatEmptyState({
  name,
  runtime,
  suggestions = [],
  onSuggestionClick,
  compact = false,
}: ChatEmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="flex h-full flex-col items-center justify-center px-4 py-8"
    >
      <div className="flex max-w-xl flex-col items-center text-center">
        <div className="mb-6">
          <AgentIdentityAvatar
            name={name}
            runtime={runtime}
            showInitials={false}
            size={compact ? 64 : 80}
          />
        </div>

        <h2
          className="text-[24px] font-semibold tracking-tight"
          style={{ color: 'var(--theme-text)' }}
        >
          {name}
        </h2>

        {suggestions.length > 0 ? (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                type="button"
                onClick={() => onSuggestionClick?.(suggestion.prompt)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium transition-all"
                style={{
                  background: 'var(--theme-card)',
                  border: '1px solid var(--theme-border)',
                  color: 'var(--theme-text)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--theme-card2)'
                  e.currentTarget.style.borderColor =
                    'var(--theme-accent-border)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--theme-card)'
                  e.currentTarget.style.borderColor = 'var(--theme-border)'
                }}
              >
                <HugeiconsIcon
                  icon={suggestion.icon as any}
                  size={14}
                  strokeWidth={1.5}
                  style={{ color: 'var(--theme-accent)' }}
                />
                {suggestion.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </motion.div>
  )
}
