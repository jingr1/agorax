'use client'

import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useProfiles } from '../hooks/use-profiles'
import { AgentStatusDot } from './agent-status-dot'
import type { AgentWithStatus } from '@/lib/agent-types'
import type { AgentPresence, UnifiedAgentStatus } from '@/lib/agent-status'
import { SettingsDialog } from '@/components/settings-dialog'
import { AgentIdentityAvatar } from '@/components/avatars'
import {
  countAgentsByProvider,
  normalizeAgentAvatarProvider,
} from '@/lib/agent-avatar'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agent-store'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import {
  AGENT_PROVIDER_BADGE_LABELS,
  providerIdForAgentRuntime,
  providerStatusBadge,
  type AgentProviderStatusDto,
} from '@/lib/managed-agent-runtime/provider-status'
import { useAgentProviderStatus } from '../hooks/use-provider-status'
import { useAgentSnapshot } from '@/hooks/use-agent-snapshot'
import type { AgentStatusEntry } from '@/lib/mission-control-api'

function presenceFromSnapshotEntry(
  entry: AgentStatusEntry | undefined,
): AgentPresence | null {
  const status = entry?.status
  if (!status?.availability || !status.workload) return null
  return {
    availability: status.availability,
    workload: status.workload,
    needsSetup: Boolean(status.needsSetup),
    blocked: Boolean(status.blocked),
    error: Boolean(status.error),
    unifiedStatus: status.unifiedStatus,
  }
}

function agentSubtitle(
  agent: AgentWithStatus,
  profile?: { model?: string; provider?: string },
  presence?: AgentPresence | null,
): string {
  if (presence?.needsSetup || presence?.unifiedStatus === 'needsSetup') {
    return 'No model configured'
  }
  if (presence) {
    if (presence.workload === 'working') return 'Working'
    if (presence.workload === 'queued') return 'Queued'
    if (presence.availability === 'unstable') return 'Unstable'
    if (presence.availability === 'offline') return 'Offline'
  }
  if (agent.runtime === 'hermes' && profile) {
    const model = profile.model?.trim()
    const provider = profile.provider?.trim()
    return (
      [model, provider].filter(Boolean).join(' · ') ||
      agentRuntimeLabel(agent.runtime)
    )
  }
  return agentRuntimeLabel(agent.runtime)
}

function providerTooltip(
  entry: AgentProviderStatusDto | undefined,
): string | null {
  if (!entry) return null
  const badge = providerStatusBadge(entry)
  const label = AGENT_PROVIDER_BADGE_LABELS[badge]
  if (badge === 'ready') {
    return entry.version ? `${label} ${entry.version}` : label
  }
  return label
}

/** Fallback when snapshot is still loading — never invent "active" from CLI ready. */
function legacyPresence(
  agent: AgentWithStatus,
  profile?: { model?: string; provider?: string },
): AgentPresence {
  if (agent.runtime === 'hermes' && agent.runtimeConfig.profile) {
    const hasModel = Boolean(profile?.model?.trim())
    if (!hasModel) {
      return {
        availability: 'offline',
        workload: 'idle',
        needsSetup: true,
        blocked: false,
        error: false,
        unifiedStatus: 'needsSetup',
      }
    }
  }

  const status = agent.status
  let unifiedStatus: UnifiedAgentStatus = 'offline'
  switch (status) {
    case 'busy':
      unifiedStatus = 'active'
      break
    case 'idle':
    case 'online':
      unifiedStatus = 'idle'
      break
    case 'blocked':
      unifiedStatus = agent.statusSnapshot?.needsHuman ? 'blocked' : 'error'
      break
    default:
      unifiedStatus = 'offline'
  }

  return {
    availability: unifiedStatus === 'offline' ? 'offline' : 'online',
    workload: unifiedStatus === 'active' ? 'working' : 'idle',
    needsSetup: false,
    blocked: unifiedStatus === 'blocked',
    error: unifiedStatus === 'error',
    unifiedStatus,
  }
}

function AgentListItem({
  agent,
  providerSiblingCount,
  isActive,
  onSelect,
  onOpenSettings,
  onOpenRuntimes,
  providerStatusEntry,
  presence,
}: {
  agent: AgentWithStatus
  providerSiblingCount: number
  isActive: boolean
  onSelect: (agentId: string) => void
  onOpenSettings: (agentId: string) => void
  onOpenRuntimes: (providerId: string) => void
  providerStatusEntry: AgentProviderStatusDto | undefined
  presence: AgentPresence | null
}) {
  const { profiles } = useProfiles()
  const profile = useMemo(() => {
    if (agent.runtime !== 'hermes') return undefined
    const targetProfileName = agent.runtimeConfig.profile ?? agent.agentId
    return profiles.find((p) => p.name === targetProfileName)
  }, [agent, profiles])

  const resolvedPresence = presence ?? legacyPresence(agent, profile)
  const providerTitle = providerTooltip(providerStatusEntry)
  const upgradeProvider =
    providerStatusBadge(providerStatusEntry) === 'update-available'
      ? providerStatusEntry?.provider
      : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(agent.agentId)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(agent.agentId)
        }
      }}
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer outline-none',
        'hover:bg-primary-200',
        isActive && 'bg-primary-200',
      )}
    >
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onOpenSettings(agent.agentId)
          }}
          className="rounded-full transition-colors hover:bg-primary-300/60"
          title="Agent settings"
        >
          <AgentIdentityAvatar
            name={agent.name}
            runtime={agent.runtime}
            providerSiblingCount={providerSiblingCount}
            size={36}
          />
        </button>
        {/* Presence top-right; initials badge already owns bottom-right. */}
        <button
          type="button"
          className={cn(
            'absolute -right-0.5 -top-0.5 z-20 flex size-3 items-center justify-center rounded-full',
            'bg-[var(--theme-bg,white)] ring-2 ring-[var(--theme-bg,white)]',
            upgradeProvider && 'cursor-pointer hover:ring-primary-300',
          )}
          tabIndex={upgradeProvider ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation()
            if (!upgradeProvider) return
            onOpenRuntimes(upgradeProvider)
          }}
        >
          <AgentStatusDot
            presence={resolvedPresence}
            className="size-2.5"
            title={
              upgradeProvider
                ? `${providerTitle ?? '需升级'} — 打开 Runtimes`
                : undefined
            }
          />
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-sm font-medium',
            isActive ? 'text-accent-500' : 'text-primary-900',
          )}
        >
          {agent.name}
        </p>
        <p className="truncate text-xs text-primary-500">
          {agentSubtitle(agent, profile, resolvedPresence)}
        </p>
      </div>
    </div>
  )
}

export function AgentList({
  onSelect,
  renderContainer = true,
}: {
  onSelect?: (agentId: string) => void
  renderContainer?: boolean
}) {
  const agents = useAgentStore((state) => state.agents)
  const activeAgentId = useAgentStore((state) => state.activeAgentId)
  const storeSetActiveAgentId = useAgentStore((state) => state.setActiveAgentId)
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null)
  const providerStatusQuery = useAgentProviderStatus()
  const { byId: snapshotById } = useAgentSnapshot()
  const navigate = useNavigate()

  const providerStatusById = useMemo(() => {
    const map = new Map<string, AgentProviderStatusDto>()
    for (const entry of providerStatusQuery.data?.providers ?? []) {
      map.set(entry.provider, entry)
    }
    return map
  }, [providerStatusQuery.data])

  const handleSelect = useCallback(
    (agentId: string) => {
      if (onSelect) {
        onSelect(agentId)
        return
      }
      storeSetActiveAgentId(agentId)
    },
    [onSelect, storeSetActiveAgentId],
  )

  const handleOpenRuntimes = useCallback(
    (providerId: string) => {
      void navigate({
        to: '/settings',
        search: { section: 'runtimes', provider: providerId },
      })
    },
    [navigate],
  )

  const sortedAgents = useMemo(() => {
    const next = [...agents]
    next.sort((a, b) => {
      if (a.agentId === 'default' && b.agentId !== 'default') return -1
      if (b.agentId === 'default' && a.agentId !== 'default') return 1
      if (a.runtime === 'hermes' && b.runtime !== 'hermes') return -1
      if (a.runtime !== 'hermes' && b.runtime === 'hermes') return 1

      const presenceOf = (agent: AgentWithStatus) =>
        presenceFromSnapshotEntry(snapshotById.get(agent.agentId))

      const priority = (agent: AgentWithStatus) => {
        const presence = presenceOf(agent)
        if (presence?.workload === 'working') return 0
        if (presence?.availability === 'online') return 1
        if (presence?.availability === 'unstable') return 2
        if (agent.status === 'busy') return 0
        if (agent.status === 'online' || agent.status === 'idle') return 1
        return 3
      }
      const aPriority = priority(a)
      const bPriority = priority(b)
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.name.localeCompare(b.name)
    })
    return next
  }, [agents, snapshotById])

  const providerSiblingCounts = useMemo(
    () => countAgentsByProvider(sortedAgents),
    [sortedAgents],
  )

  const listContent = (
    <>
      {sortedAgents.length === 0 ? (
        <p className="px-3 py-4 text-sm text-primary-500 dark:text-primary-400">
          No agents configured.
        </p>
      ) : (
        <div className="space-y-0.5">
          {sortedAgents.map((agent) => {
            const providerId =
              providerIdForAgentRuntime(agent.runtime) ??
              (agent.runtime === 'hermes'
                ? 'hermes'
                : agent.runtime === 'deepseek-harness'
                  ? 'deepseek-harness'
                  : null)
            return (
              <AgentListItem
                key={agent.agentId}
                agent={agent}
                providerSiblingCount={
                  providerSiblingCounts.get(
                    normalizeAgentAvatarProvider(agent.runtime),
                  ) ?? 1
                }
                isActive={agent.agentId === activeAgentId}
                onSelect={handleSelect}
                onOpenSettings={setSettingsAgentId}
                onOpenRuntimes={handleOpenRuntimes}
                providerStatusEntry={
                  providerId ? providerStatusById.get(providerId) : undefined
                }
                presence={presenceFromSnapshotEntry(
                  snapshotById.get(agent.agentId),
                )}
              />
            )
          })}
        </div>
      )}
    </>
  )

  const settingsDialog = (
    <SettingsDialog
      open={settingsAgentId !== null}
      onOpenChange={(open) => {
        if (!open) setSettingsAgentId(null)
      }}
      agentId={settingsAgentId ?? undefined}
      initialSection="claude"
    />
  )

  if (!renderContainer) {
    return (
      <>
        {listContent}
        {settingsDialog}
      </>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-primary-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-primary-500 dark:border-primary-800 dark:text-primary-400">
        Agents
      </div>
      <div className="flex-1 overflow-y-auto p-2">{listContent}</div>
      {settingsDialog}
    </div>
  )
}
