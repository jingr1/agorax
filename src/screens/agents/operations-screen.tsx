import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { motion } from 'motion/react'
import { seedAgentPresets } from './agent-presets'
import { PlusSignIcon, UserMultipleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { PageHeader } from '@/components/layout/page-header'
import { PageShell } from '@/components/layout/page-shell'
import { Section } from '@/components/layout/section'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/screens/dashboard/lib/formatters'
import { OperationsAgentCard } from './components/operations-agent-card'
import { OperationsAgentDetail } from './components/operations-agent-detail'
import { OperationsNewAgentModal } from './components/operations-new-agent-modal'
import { AgentBusPanel as SwarmHealthBar } from './components/agent-bus-panel'
import {
  TeamOverview,
  type TeamOverviewFilter,
} from './components/team-overview'
import { useOperations } from './hooks/use-operations'

export const THEME_STYLE: CSSProperties = {
  ['--theme-bg' as string]: 'var(--color-surface)',
  ['--theme-card' as string]: 'var(--color-primary-50)',
  ['--theme-card2' as string]: 'var(--color-primary-100)',
  ['--theme-border' as string]: 'var(--color-primary-200)',
  ['--theme-border2' as string]: 'var(--color-primary-400)',
  ['--theme-text' as string]: 'var(--color-ink)',
  ['--theme-muted' as string]: 'var(--color-primary-700)',
  ['--theme-muted-2' as string]: 'var(--color-primary-600)',
  ['--theme-accent' as string]: 'var(--color-accent-500)',
  ['--theme-accent-strong' as string]: 'var(--color-accent-600)',
  ['--theme-accent-soft' as string]:
    'color-mix(in srgb, var(--color-accent-500) 12%, transparent)',
  ['--theme-accent-soft-strong' as string]:
    'color-mix(in srgb, var(--color-accent-500) 18%, transparent)',
  ['--theme-shadow' as string]:
    'color-mix(in srgb, var(--color-primary-950) 14%, transparent)',
  ['--theme-danger' as string]: 'var(--color-red-600, #dc2626)',
  ['--theme-danger-soft' as string]:
    'color-mix(in srgb, var(--theme-danger) 12%, transparent)',
  ['--theme-danger-soft-strong' as string]:
    'color-mix(in srgb, var(--theme-danger) 18%, transparent)',
  ['--theme-danger-border' as string]:
    'color-mix(in srgb, var(--theme-danger) 35%, white)',
  ['--theme-warning' as string]: 'var(--color-amber-600, #d97706)',
  ['--theme-warning-soft' as string]:
    'color-mix(in srgb, var(--theme-warning) 12%, transparent)',
  ['--theme-warning-soft-strong' as string]:
    'color-mix(in srgb, var(--theme-warning) 18%, transparent)',
  ['--theme-warning-border' as string]:
    'color-mix(in srgb, var(--theme-warning) 35%, white)',
}

export function OperationsScreen() {
  useEffect(() => {
    seedAgentPresets()
  }, [])
  const navigate = useNavigate()
  const { agent: agentFromSearch } = useSearch({ from: '/agents' })
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(
    agentFromSearch ?? null,
  )
  const [filter, setFilter] = useState<TeamOverviewFilter>('all')
  const {
    agents,
    recentActivity,
    configQuery,
    sessionsQuery,
    cronJobsQuery,
    snapshotQuery,
    healthSummary,
    enableUsagePolling,
    defaultModel,
    createAgent,
    isCreatingAgent,
    saveAgent,
    isSavingAgent,
    deleteAgent,
    isDeletingAgent,
    activateAgent,
    isActivatingAgent,
    renameAgent,
    isRenamingAgent,
    toggleSkill,
    isTogglingSkill,
    toggleMcp,
    isTogglingMcp,
    removeMcp,
    isRemovingMcp,
  } = useOperations()

  const filteredAgents = useMemo(() => {
    if (filter === 'all') return agents
    if (filter === 'needsSetup')
      return agents.filter((agent) => agent.needsSetup)
    return agents.filter((agent) => agent.status === filter)
  }, [agents, filter])

  const isLoading =
    configQuery.isPending || sessionsQuery.isPending || cronJobsQuery.isPending
  const error =
    (configQuery.error instanceof Error && configQuery.error.message) ||
    (sessionsQuery.error instanceof Error && sessionsQuery.error.message) ||
    (cronJobsQuery.error instanceof Error && cronJobsQuery.error.message) ||
    null
  const settingsAgent =
    agents.find((agent) => agent.id === settingsAgentId) ?? null

  useEffect(() => {
    if (agentFromSearch) setSettingsAgentId(agentFromSearch)
  }, [agentFromSearch])

  useEffect(() => {
    if (settingsAgentId) enableUsagePolling()
  }, [settingsAgentId, enableUsagePolling])

  function closeAgentDetail() {
    setSettingsAgentId(null)
    if (agentFromSearch) {
      void navigate({ to: '/agents', search: {} })
    }
  }

  return (
    <PageShell style={THEME_STYLE} contentClassName="gap-4">
      <PageHeader
        icon={UserMultipleIcon}
        title="Agents"
        description="Configure your persistent agent team"
        actions={
          <Button onClick={() => setNewAgentOpen(true)}>
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.8} />
            New Agent
          </Button>
        }
      />

      {isLoading ? (
        <Section className="py-12 text-center text-sm text-fg-muted">
          Loading Agents roster…
        </Section>
      ) : error ? (
        <Section className="border-danger/35 bg-danger/10 py-12 text-center text-sm text-fg">
          {error}
        </Section>
      ) : (
        <>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
          >
            <TeamOverview
              agents={agents}
              filter={filter}
              onFilterChange={setFilter}
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.25 }}
          >
            <SwarmHealthBar
              health={healthSummary}
              checkedAt={snapshotQuery.data?.checkedAt ?? null}
              agentCount={agents.length}
            />
          </motion.div>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredAgents.map((agent, index) => (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04, duration: 0.22 }}
              >
                <OperationsAgentCard
                  agent={agent}
                  providerSiblingCount={agents.length}
                  onOpenSettings={(agentId) => setSettingsAgentId(agentId)}
                />
              </motion.div>
            ))}
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                delay: filteredAgents.length * 0.04,
                duration: 0.22,
              }}
              onClick={() => setNewAgentOpen(true)}
              className="flex min-h-[19rem] flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-[var(--theme-border)] bg-[var(--theme-card)] p-4 text-center shadow-[0_20px_60px_color-mix(in_srgb,var(--theme-shadow)_10%,transparent)] transition-colors hover:border-[var(--theme-accent)] hover:bg-[var(--theme-accent-soft)]"
            >
              <HugeiconsIcon
                icon={PlusSignIcon}
                size={32}
                strokeWidth={1.7}
                className="text-[var(--theme-muted)]"
              />
              <span className="mt-3 text-sm text-[var(--theme-muted)]">
                Add Agent
              </span>
            </motion.button>
          </section>

          <Section
            title="Recent Activity"
            description="Latest outputs across the team"
          >
            <div className="space-y-2">
              {recentActivity.length > 0 ? (
                recentActivity.map((activity) => {
                  const agent = agents.find(
                    (entry) => entry.id === activity.agentId,
                  )
                  return (
                    <div
                      key={activity.id}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 md:flex-row md:items-center md:justify-between"
                    >
                      <p className="text-sm text-fg">
                        <span className="mr-2">
                          {agent?.meta.emoji ?? '🤖'}
                        </span>
                        <span className="font-medium">
                          {agent?.name ?? activity.agentId}:
                        </span>{' '}
                        {activity.summary}
                      </p>
                      <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                        {formatRelativeTime(activity.timestamp)}
                      </span>
                    </div>
                  )
                })
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-sm text-fg-muted">
                  No recent activity yet.
                </div>
              )}
            </div>
          </Section>
        </>
      )}

      <OperationsNewAgentModal
        open={newAgentOpen}
        defaultModel={defaultModel}
        cloneOptions={agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
        }))}
        onClose={() => setNewAgentOpen(false)}
        onCreate={createAgent}
        isSaving={isCreatingAgent}
      />

      <OperationsAgentDetail
        open={Boolean(settingsAgent)}
        agent={settingsAgent}
        onClose={closeAgentDetail}
        onSave={saveAgent}
        onDelete={async (agentId) => {
          await deleteAgent(agentId)
          setSettingsAgentId((current) =>
            current === agentId ? null : current,
          )
          if (agentFromSearch === agentId) {
            void navigate({ to: '/agents', search: {} })
          }
        }}
        onActivate={activateAgent}
        isActivating={isActivatingAgent}
        onRename={renameAgent}
        isRenaming={isRenamingAgent}
        isSaving={isSavingAgent}
        isDeleting={isDeletingAgent}
        onToggleSkill={toggleSkill}
        isTogglingSkill={isTogglingSkill}
        onToggleMcp={toggleMcp}
        isTogglingMcp={isTogglingMcp}
        onRemoveMcp={removeMcp}
        isRemovingMcp={isRemovingMcp}
      />
    </PageShell>
  )
}
