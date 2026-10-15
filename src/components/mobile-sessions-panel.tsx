import { useCallback, useEffect, useMemo } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Add01Icon,
  Chat01Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons'
import type { SessionMeta } from '@/screens/chat/types'
import {
  setActiveProfileOptimistic,
  useGatewayPoolStatus,
  useProfiles,
} from '@/screens/chat/hooks/use-profiles'
import {
  chatQueryKeys,
  fetchHistory,
  fetchSessions,
} from '@/screens/chat/chat-queries'
import {
  resolveSessionForProfile,
  writeLastSession,
} from '@/screens/chat/last-session'
import { requestStreamHandoffIfActive } from '@/lib/stream-handoff-bridge'
import { preloadWorkspaceFolders } from '@/components/workspace-folder-picker'
import { cn } from '@/lib/utils'

type Props = {
  open: boolean
  onClose: () => void
  sessions: Array<SessionMeta>
  activeFriendlyId: string
  onSelectSession: (key: string) => void
  onNewChat: () => void
}

function normalizeLabel(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function getSessionTitle(session: SessionMeta): string {
  const label = normalizeLabel(session.label)
  if (label) return label
  const derivedTitle = normalizeLabel(session.derivedTitle)
  if (derivedTitle) return derivedTitle
  const title = normalizeLabel(session.title)
  if (title) return title
  return `Session ${session.friendlyId.slice(0, 8)}`
}

function profileMeta(profile: { model?: string; provider?: string }): string {
  const model = typeof profile.model === 'string' ? profile.model.trim() : ''
  const provider =
    typeof profile.provider === 'string' ? profile.provider.trim() : ''
  return [model ? `${model}` : '', provider ? `${provider}` : '']
    .filter(Boolean)
    .join(' · ')
}

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

function formatUpdatedAt(updatedAt?: number): string {
  if (typeof updatedAt !== 'number') return ''
  const value = new Date(updatedAt)
  const now = new Date()
  if (value.toDateString() === now.toDateString()) {
    return timeFormatter.format(value)
  }
  return dayFormatter.format(value)
}

function prefetchSessionHistory(
  queryClient: ReturnType<typeof useQueryClient>,
  profileName: string,
  sessionId: string,
) {
  if (!sessionId || sessionId === 'new') return
  void queryClient.prefetchQuery({
    queryKey: chatQueryKeys.history(sessionId, sessionId),
    queryFn: () =>
      fetchHistory({
        sessionKey: sessionId,
        friendlyId: sessionId,
        profile: profileName,
      }),
    staleTime: 10_000,
  })
}

export function MobileSessionsPanel({
  open,
  onClose,
  sessions,
  activeFriendlyId,
  onSelectSession,
  onNewChat,
}: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    profiles,
    activeProfileName,
    activateProfile,
    isLoading: profilesLoading,
    isError: profilesError,
  } = useProfiles()
  const gatewayPoolQuery = useGatewayPoolStatus()

  const gatewayByName = useMemo(() => {
    const map = new Map<string, { state?: string; port?: number }>()
    for (const entry of gatewayPoolQuery.data?.gateways ?? []) {
      map.set(entry.profile, entry)
    }
    return map
  }, [gatewayPoolQuery.data?.gateways])

  const sortedProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => a.name.localeCompare(b.name))
  }, [profiles])

  const handleSelectProfile = useCallback(
    (profileName: string) => {
      if (profileName === activeProfileName) return

      void (async () => {
        await requestStreamHandoffIfActive()

        writeLastSession(activeFriendlyId, activeProfileName)
        setActiveProfileOptimistic(queryClient, profileName)
        preloadWorkspaceFolders(profileName)
        activateProfile(profileName)

        let profileSessions = queryClient.getQueryData<Array<SessionMeta>>(
          chatQueryKeys.sessionsForProfile(profileName),
        )
        let sessionsLoaded = Boolean(profileSessions)
        if (!profileSessions) {
          try {
            profileSessions = await queryClient.fetchQuery({
              queryKey: chatQueryKeys.sessionsForProfile(profileName),
              queryFn: () => fetchSessions(profileName),
              staleTime: 60_000,
            })
            sessionsLoaded = true
          } catch {
            profileSessions = []
            sessionsLoaded = true
          }
        }
        const targetSession = resolveSessionForProfile(
          profileSessions,
          profileName,
          {
            sessionsLoaded,
          },
        )
        prefetchSessionHistory(queryClient, profileName, targetSession)
        onClose()
        navigate({
          to: '/chat/$sessionKey',
          params: { sessionKey: targetSession },
        })
      })()
    },
    [
      activateProfile,
      activeFriendlyId,
      activeProfileName,
      navigate,
      onClose,
      queryClient,
    ],
  )

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[97] no-swipe">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 animate-in fade-in duration-200"
        aria-label="Close sessions panel"
        onClick={onClose}
      />

      <aside
        className="no-swipe absolute inset-y-0 left-0 w-[80vw] max-w-sm border-r shadow-2xl animate-in slide-in-from-left-8 duration-200"
        style={{
          background: 'var(--color-surface, #fff)',
          borderColor: 'var(--color-border, #e5e7eb)',
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex min-h-0 max-h-[38vh] shrink-0 flex-col border-b border-primary-200">
            <div className="flex shrink-0 items-center justify-between px-4 py-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
                Profiles
              </h2>
              <Link
                to="/profiles"
                onClick={onClose}
                className="inline-flex size-7 items-center justify-center rounded-lg text-primary-500 transition-colors hover:bg-primary-100"
                title="Manage profiles"
              >
                <HugeiconsIcon
                  icon={UserGroupIcon}
                  size={14}
                  strokeWidth={1.5}
                />
              </Link>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {profilesLoading && profiles.length === 0 ? (
                <div className="px-2 py-1 text-xs text-primary-500">
                  Loading profiles…
                </div>
              ) : profilesError ? (
                <div className="px-2 py-1 text-xs text-red-500">
                  Failed to load profiles.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {sortedProfiles.map((profile) => {
                    const isActive = profile.name === activeProfileName
                    const gateway = gatewayByName.get(profile.name)
                    const gatewayHealthy =
                      gateway?.state === 'healthy' ||
                      profile.gatewayState === 'healthy'
                    const gatewayPort = gateway?.port ?? profile.gatewayPort
                    return (
                      <button
                        key={profile.name}
                        type="button"
                        onClick={() => handleSelectProfile(profile.name)}
                        className={cn(
                          'flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors',
                          isActive
                            ? 'border border-accent-300 bg-accent-50'
                            : 'border border-transparent bg-primary-50 hover:border-primary-200',
                        )}
                        title={
                          gatewayHealthy
                            ? `${profile.name} — gateway running${gatewayPort ? ` :${gatewayPort}` : ''}`
                            : `${profile.name} — gateway stopped`
                        }
                      >
                        <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                          <span
                            className={cn(
                              'size-1.5 shrink-0 rounded-full',
                              gatewayHealthy
                                ? 'bg-emerald-400'
                                : 'bg-neutral-500',
                            )}
                            aria-hidden="true"
                          />
                          <span className="truncate">{profile.name}</span>
                          {isActive ? (
                            <span className="shrink-0 text-[9px] text-primary-500">
                              active
                            </span>
                          ) : null}
                        </span>
                        {profileMeta(profile) ? (
                          <span className="mt-0.5 truncate text-[10px] text-primary-500">
                            {profileMeta(profile)}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-primary-200 px-4 py-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-wider text-primary-500">
                Sessions
              </h2>
              <button
                type="button"
                onClick={onNewChat}
                className="inline-flex items-center gap-1 rounded-lg border border-primary-200 bg-primary-50 px-2.5 py-1.5 text-xs font-medium text-primary-700 transition-colors hover:border-accent-200 hover:text-accent-600"
              >
                <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.8} />
                New Chat
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {sessions.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-primary-500">
                  <HugeiconsIcon
                    icon={Chat01Icon}
                    size={24}
                    strokeWidth={1.6}
                  />
                  <p className="text-sm">No sessions yet.</p>
                  <p className="text-xs text-primary-400">
                    Start a conversation to see it here.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {sessions.map((session) => {
                    const active = session.friendlyId === activeFriendlyId
                    const timestamp = formatUpdatedAt(session.updatedAt)
                    return (
                      <button
                        key={session.key}
                        type="button"
                        onClick={() => onSelectSession(session.friendlyId)}
                        className={cn(
                          'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                          active
                            ? 'border-accent-300 bg-accent-50'
                            : 'border-transparent bg-primary-50 hover:border-primary-200',
                        )}
                      >
                        <div className="truncate text-sm font-medium text-ink">
                          {getSessionTitle(session)}
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-primary-500">
                          <span className="truncate">{session.friendlyId}</span>
                          {timestamp ? <span>{timestamp}</span> : null}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}
