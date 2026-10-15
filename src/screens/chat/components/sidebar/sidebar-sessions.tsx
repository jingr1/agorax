'use client'

import { memo, useMemo } from 'react'
import { SessionItem } from './session-item'
import type { SessionMeta } from '../../types'
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { usePinnedSessions } from '@/hooks/use-pinned-sessions'

type SidebarSessionsProps = {
  sessions: Array<SessionMeta>
  activeFriendlyId: string
  profileName?: string
  defaultOpen?: boolean
  onSelect?: () => void
  /** Agent Workspace: activate session without Hermes /chat navigation. */
  onActivateSession?: (session: SessionMeta) => void
  onRename: (session: SessionMeta, newTitle: string) => void
  onDelete: (session: SessionMeta) => void
  loading: boolean
  fetching: boolean
  error: string | null
  onRetry: () => void
}

export const SidebarSessions = memo(function SidebarSessions({
  sessions,
  activeFriendlyId,
  profileName,
  defaultOpen = true,
  onSelect,
  onActivateSession,
  onRename,
  onDelete,
  loading,
  fetching,
  error,
  onRetry,
}: SidebarSessionsProps) {
  const { pinnedSessionKeys, togglePinnedSession } = usePinnedSessions()

  const [pinnedSessions, unpinnedSessions] = useMemo(() => {
    const pinnedKeys = new Set(pinnedSessionKeys)
    const pinned: Array<SessionMeta> = []
    const unpinned: Array<SessionMeta> = []
    for (const session of sessions) {
      if (pinnedKeys.has(session.key)) {
        pinned.push(session)
      } else {
        unpinned.push(session)
      }
    }
    return [pinned, unpinned] as const
  }, [pinnedSessionKeys, sessions])

  function handleTogglePin(session: SessionMeta) {
    togglePinnedSession(session.key)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      {pinnedSessions.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-px pl-3 pr-2 pt-1">
          {pinnedSessions.map((session) => (
            <SessionItem
              key={session.key}
              session={session}
              active={session.friendlyId === activeFriendlyId}
              profileName={profileName}
              isPinned
              onSelect={onSelect}
              onActivateSession={onActivateSession}
              onTogglePin={handleTogglePin}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}

      <ScrollAreaRoot className="flex-1 min-h-0">
        <ScrollAreaViewport className="min-h-0">
          <div className="flex flex-col gap-px pl-3 pr-2">
            {loading ? (
              <div className="px-2 py-2 text-xs text-primary-500">
                Loading sessions…
              </div>
            ) : error ? (
              <div className="px-2 py-2 text-xs text-primary-500">
                <div className="mb-2">Failed to load sessions.</div>
                <div className="text-[11px] opacity-80">{error}</div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              </div>
            ) : unpinnedSessions.length > 0 ? (
              <>
                {pinnedSessions.length > 0 ? (
                  <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
                ) : null}
                {unpinnedSessions.map((session) => (
                  <SessionItem
                    key={session.key}
                    session={session}
                    active={session.friendlyId === activeFriendlyId}
                    profileName={profileName}
                    isPinned={false}
                    onSelect={onSelect}
                    onActivateSession={onActivateSession}
                    onTogglePin={handleTogglePin}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                ))}
              </>
            ) : (
              <div className="px-2 py-2 text-xs text-primary-500">
                {pinnedSessions.length > 0
                  ? 'All sessions are pinned.'
                  : 'No sessions yet. Start a conversation →'}
              </div>
            )}
            {fetching && !loading && !error && sessions.length > 0 ? (
              <div className="px-2 py-1 text-[11px] text-primary-400">
                Updating…
              </div>
            ) : null}
          </div>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar orientation="vertical">
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      </ScrollAreaRoot>
    </div>
  )
}, areSidebarSessionsEqual)

function areSidebarSessionsEqual(
  prev: SidebarSessionsProps,
  next: SidebarSessionsProps,
) {
  if (prev.activeFriendlyId !== next.activeFriendlyId) return false
  if (prev.profileName !== next.profileName) return false
  if (prev.defaultOpen !== next.defaultOpen) return false
  if (prev.onSelect !== next.onSelect) return false
  if (prev.onActivateSession !== next.onActivateSession) return false
  if (prev.onRename !== next.onRename) return false
  if (prev.onDelete !== next.onDelete) return false
  if (prev.loading !== next.loading) return false
  if (prev.fetching !== next.fetching) return false
  if (prev.error !== next.error) return false
  if (prev.onRetry !== next.onRetry) return false
  if (prev.sessions === next.sessions) return true
  if (prev.sessions.length !== next.sessions.length) return false
  for (let i = 0; i < prev.sessions.length; i += 1) {
    const prevSession = prev.sessions[i]
    const nextSession = next.sessions[i]
    if (prevSession.key !== nextSession.key) return false
    if (prevSession.friendlyId !== nextSession.friendlyId) return false
    if (prevSession.label !== nextSession.label) return false
    if (prevSession.title !== nextSession.title) return false
    if (prevSession.derivedTitle !== nextSession.derivedTitle) return false
    if (prevSession.updatedAt !== nextSession.updatedAt) return false
    if (prevSession.titleStatus !== nextSession.titleStatus) return false
    if (prevSession.titleSource !== nextSession.titleSource) return false
    if (prevSession.titleError !== nextSession.titleError) return false
  }
  return true
}
