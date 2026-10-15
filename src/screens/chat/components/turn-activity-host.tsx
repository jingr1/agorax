/**
 * Live-turn Activity host (Working → thinking/tools) for the whole busy turn.
 *
 * Same card from submit through reply streaming — MessageItem only adds the
 * text bubble underneath. Do not remount Working into MessageItem when
 * assistant:<runId> appears or when the first token lands.
 */

import { memo, useMemo } from 'react'
import { AssistantAvatar } from '@/components/avatars'
import { cn } from '@/lib/utils'
import {
  projectTurnActivity,
  type TurnActivityVM,
} from '@/lib/turn-activity'
import {
  TuiActivityCard,
  type TuiToolSection,
} from './tui-activity-card'

export type TurnActivityHostProps = {
  turnBusy: boolean
  thinkingText?: string | null
  toolSections?: ReadonlyArray<TuiToolSection>
  thinkingElapsedSeconds?: number
  expandAll?: boolean
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
  className?: string
  /** Optional precomputed VM (tests / managed projection). */
  vm?: TurnActivityVM
}

function TurnActivityHostComponent({
  turnBusy,
  thinkingText,
  toolSections = [],
  thinkingElapsedSeconds = 0,
  expandAll,
  formatLabel,
  formatArg,
  className,
  vm: vmProp,
}: TurnActivityHostProps) {
  const vm = useMemo(
    () =>
      vmProp ??
      projectTurnActivity({
        turnBusy,
        thinkingText,
        toolSections,
      }),
    [vmProp, turnBusy, thinkingText, toolSections],
  )

  if (!vm.shouldMount) return null

  const hasContent =
    vm.thinkingText.length > 0 || vm.toolSections.length > 0
  // Glow only before first thinking/tools — after content arrives the card
  // is the busy chrome, not the avatar ring.
  const pulseAvatar = vm.turnBusy && !hasContent

  return (
    <div
      className={className ?? 'flex items-end gap-2'}
      role="status"
      aria-live="polite"
      data-turn-activity-host=""
      data-turn-busy={vm.turnBusy ? 'true' : 'false'}
      data-status-label={vm.statusLabel}
    >
      <AssistantAvatar
        size={24}
        className={cn(
          'shrink-0',
          pulseAvatar ? 'thinking-avatar-glow' : undefined,
        )}
        alt={pulseAvatar ? 'Working' : undefined}
      />
      <div className="min-w-0 flex-1">
        <TuiActivityCard
          toolSections={vm.toolSections}
          thinking={vm.thinkingText || null}
          thinkingElapsedSeconds={thinkingElapsedSeconds}
          isStreaming={vm.turnBusy}
          keepMountedWhileBusy
          statusTitle={vm.turnBusy ? '⚡ Working' : 'Activity'}
          expandAll={expandAll}
          formatLabel={formatLabel}
          formatArg={formatArg}
        />
      </div>
    </div>
  )
}

export const TurnActivityHost = memo(TurnActivityHostComponent)
