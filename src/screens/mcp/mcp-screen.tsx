import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import { McpServerCard } from './components/mcp-server-card'
import { McpServerDialog } from './components/mcp-server-dialog'
import { InstallConfirmationDialog } from './components/install-confirmation-dialog'
import { useMcpCapabilityMode } from './hooks/use-mcp-capability-mode'
import { useMcpServers } from './hooks/use-mcp-servers'
import { useMcpHub } from './hooks/use-mcp-hub'
import { SourcesManagerDialog } from './components/sources-manager-dialog'
import type { HubMcpEntry } from './hooks/use-mcp-hub'
import type { McpClientInput, McpServer } from '@/types/mcp'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  useAgentMcpBindings,
  useAssignAgentMcp,
  useDeletePlatformMcp,
  usePlatformMcpLibrary,
  useRemoveAgentMcp,
  useSetAgentMcpEnabled,
  type PlatformMcpSummary,
} from './hooks/use-platform-mcp'

type Tab = 'library' | 'agents' | 'installed' | 'marketplace'

const TOOLBAR_FIELD =
  'h-9 w-full min-w-0 rounded-lg border border-primary-200 bg-primary-100/60 px-3 text-sm text-ink outline-none transition-colors focus:border-primary sm:min-w-[220px]'

export function McpScreen() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('library')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<McpServer | McpClientInput | null>(
    null,
  )
  const [installEntry, setInstallEntry] = useState<HubMcpEntry | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState('')

  const { mode: capabilityMode } = useMcpCapabilityMode()
  const libraryQuery = usePlatformMcpLibrary()
  const serverListTab = tab === 'marketplace' || tab === 'library' || tab === 'agents'
    ? 'installed'
    : tab
  const query = useMcpServers({
    tab: serverListTab as 'installed',
    category,
    search: tab === 'installed' ? search : '',
  })
  const servers = query.data?.servers ?? []
  const categories = query.data?.categories ?? ['All']
  const hubQuery = useMcpHub(tab === 'marketplace' ? search : '')

  const agentsQuery = useQuery({
    queryKey: ['mcp-agents-list'],
    queryFn: async (): Promise<
      Array<{ agentId: string; name: string; runtime: string }>
    > => {
      const response = await fetch('/api/agents')
      const payload = (await response.json()) as {
        agents?: Array<{
          agentId: string
          name?: string
          runtime?: string
        }>
        error?: string
      }
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load agents')
      }
      return (payload.agents ?? [])
        .filter((a) => Boolean(a.agentId))
        .map((a) => ({
          agentId: a.agentId,
          name: a.name || a.agentId,
          runtime: a.runtime || 'unknown',
        }))
    },
    staleTime: 60_000,
  })
  const agents = agentsQuery.data ?? []

  useEffect(() => {
    if (!agents.length || selectedAgent) return
    setSelectedAgent(agents[0]!.agentId)
  }, [agents, selectedAgent])

  const bindingsQuery = useAgentMcpBindings(selectedAgent)
  const assignMcp = useAssignAgentMcp()
  const setEnabled = useSetAgentMcpEnabled()
  const removeBinding = useRemoveAgentMcp()
  const deleteLibrary = useDeletePlatformMcp()
  const selectedRuntime =
    agents.find((a) => a.agentId === selectedAgent)?.runtime ?? ''
  const selectedIsHermes = selectedRuntime === 'hermes' || !selectedRuntime

  function handleTabChange(next: string | number | null) {
    if (
      next === 'library' ||
      next === 'agents' ||
      next === 'installed' ||
      next === 'marketplace'
    ) {
      setTab(next)
      setSearch('')
    }
  }

  const libraryServers = useMemo(() => {
    const all = libraryQuery.data ?? []
    if (!search.trim()) return all
    const q = search.toLowerCase()
    return all.filter((s) => s.name.toLowerCase().includes(q))
  }, [libraryQuery.data, search])

  const totalLabel =
    tab === 'marketplace'
      ? `${(hubQuery.data?.total ?? 0).toLocaleString()} results`
      : tab === 'library'
        ? `${libraryServers.length.toLocaleString()} in library`
        : tab === 'agents'
          ? `${(bindingsQuery.data ?? []).length.toLocaleString()} assigned`
          : `${servers.length.toLocaleString()} on profile`

  return (
    <div className="min-h-full overflow-y-auto bg-surface text-ink">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-6 pb-[calc(var(--tabbar-h,80px)+1.5rem)] sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-primary-200 bg-primary-50/85 p-4 backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase text-primary-500 tabular-nums">
                Agorax · MCP
              </p>
              <h1 className="text-2xl font-medium text-ink text-balance sm:text-3xl">
                MCP Servers
              </h1>
              <p className="text-sm text-primary-500 text-pretty sm:text-base">
                Platform library + per-agent assignment (like Skills). Library
                entries are not granted until you assign them.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              Add to Library
            </Button>
          </div>
          {capabilityMode === 'fallback' ? (
            <div
              role="status"
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            >
              Local profile mode — MCP CRUD uses config.yaml. Test, Discover,
              and Logs need native hermes-agent /api/mcp endpoints.
            </div>
          ) : null}
        </header>

        <section className="rounded-2xl border border-primary-200 bg-primary-50/80 p-3 backdrop-blur-xl sm:p-4">
          <Tabs value={tab} onValueChange={handleTabChange}>
            <div className="flex flex-wrap items-center gap-2">
              <TabsList
                className="rounded-xl border border-primary-200 bg-primary-100/60 p-1"
                variant="default"
              >
                <TabsTab value="library" className="min-w-[100px]">
                  Library
                </TabsTab>
                <TabsTab value="agents" className="min-w-[100px]">
                  Agents
                </TabsTab>
                <TabsTab value="installed" className="min-w-[100px]">
                  Profile
                </TabsTab>
                <TabsTab value="marketplace" className="min-w-[110px]">
                  Marketplace
                </TabsTab>
              </TabsList>

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={
                  tab === 'marketplace'
                    ? 'Search MCP catalog…'
                    : tab === 'library'
                      ? 'Search library by name'
                      : 'Search…'
                }
                className={`${TOOLBAR_FIELD} flex-1`}
              />

              {tab === 'installed' ? (
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  className="h-9 rounded-lg border border-primary-200 bg-primary-100/60 px-3 text-sm text-ink outline-none"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : null}

              {tab === 'agents' ? (
                <select
                  value={selectedAgent}
                  onChange={(event) => setSelectedAgent(event.target.value)}
                  className="h-9 rounded-lg border border-primary-200 bg-primary-100/60 px-3 text-sm text-ink outline-none"
                >
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.name} ({a.runtime})
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            <TabsPanel value="library" className="pt-3">
              <LibraryList
                servers={libraryServers}
                loading={libraryQuery.isPending}
                error={
                  libraryQuery.error instanceof Error
                    ? libraryQuery.error.message
                    : null
                }
                onDelete={(id) => deleteLibrary.mutate(id)}
                deleting={deleteLibrary.isPending}
              />
            </TabsPanel>

            <TabsPanel value="agents" className="pt-3 space-y-4">
              {!selectedIsHermes ? (
                <p className="text-xs text-primary-500">
                  Managed runtime ({selectedRuntime}): bindings are stored in
                  the platform library and injected at run start (Claude Code
                  per-run mcp-config). No Hermes profile config.yaml write.
                </p>
              ) : null}
              <AgentAssignPanel
                agentId={selectedAgent}
                library={libraryQuery.data ?? []}
                bindings={bindingsQuery.data ?? []}
                loading={bindingsQuery.isPending}
                onAssign={(serverId) =>
                  assignMcp.mutate({
                    agentId: selectedAgent,
                    serverIds: [serverId],
                  })
                }
                onToggle={(serverId, enabled) =>
                  setEnabled.mutate({
                    agentId: selectedAgent,
                    serverId,
                    enabled,
                  })
                }
                onRemove={(serverId) =>
                  removeBinding.mutate({
                    agentId: selectedAgent,
                    serverId,
                  })
                }
                busy={
                  assignMcp.isPending ||
                  setEnabled.isPending ||
                  removeBinding.isPending
                }
              />
            </TabsPanel>

            <TabsPanel value="installed" className="pt-3">
              <p className="mb-3 text-xs text-primary-500">
                Active profile snapshot of mcp_servers (includes materialized
                platform bindings and private entries). Prefer Library + Agents
                for shared servers.
              </p>
              <ServerList
                query={query}
                onEdit={(s) => {
                  setEditing(s)
                  setDialogOpen(true)
                }}
              />
            </TabsPanel>

            <TabsPanel value="marketplace" className="pt-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                {hubQuery.data?.source ? (
                  <div className="text-xs text-primary-500">
                    Source: {hubQuery.data.source}
                  </div>
                ) : (
                  <div />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSourcesOpen(true)}
                >
                  Sources
                </Button>
              </div>

              {hubQuery.data?.warnings && hubQuery.data.warnings.length > 0 ? (
                hubQuery.data.results && hubQuery.data.results.length > 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    One or more sources unavailable; showing local results.
                    <span className="ml-1 text-[11px] text-primary-500">
                      ({hubQuery.data.warnings[0]})
                    </span>
                  </p>
                ) : (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                    {hubQuery.data.warnings[0]}
                  </div>
                )
              ) : null}

              {hubQuery.error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                  {hubQuery.error instanceof Error
                    ? hubQuery.error.message
                    : 'Failed to load marketplace.'}
                </div>
              ) : null}

              <MarketplaceGrid
                entries={(hubQuery.data?.results ?? []).filter(
                  (e) => !e.installed,
                )}
                loading={hubQuery.isPending}
                onInstall={setInstallEntry}
              />

              {hubQuery.hasNextPage ? (
                <div className="flex items-center justify-center pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={hubQuery.isFetchingNextPage}
                    onClick={() => hubQuery.fetchNextPage()}
                  >
                    {hubQuery.isFetchingNextPage
                      ? 'Loading…'
                      : `Load more (${(hubQuery.data?.results.length ?? 0).toLocaleString()} of ${(hubQuery.data?.total ?? 0).toLocaleString()})`}
                  </Button>
                </div>
              ) : null}
            </TabsPanel>
          </Tabs>
        </section>

        <footer className="flex items-center justify-between rounded-xl border border-primary-200 bg-primary-50/80 px-3 py-2.5 text-sm text-primary-500 tabular-nums">
          <span>{totalLabel}</span>
          <span className="text-xs">
            mode:{' '}
            {capabilityMode === 'fallback' ? 'profile fallback' : 'native'}
          </span>
        </footer>
      </div>

      <McpServerDialog
        open={dialogOpen}
        initial={editing}
        target={editing ? 'profile' : 'library'}
        onClose={() => setDialogOpen(false)}
      />

      <InstallConfirmationDialog
        entry={installEntry}
        onClose={() => setInstallEntry(null)}
        onInstalled={() => {
          queryClient.invalidateQueries({ queryKey: ['platform-mcp'] })
          queryClient.invalidateQueries({ queryKey: ['mcp', 'servers'] })
          queryClient.invalidateQueries({ queryKey: ['mcp', 'hub-search'] })
        }}
      />

      <SourcesManagerDialog
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
      />
    </div>
  )
}

function LibraryList({
  servers,
  loading,
  error,
  onDelete,
  deleting,
}: {
  servers: Array<PlatformMcpSummary>
  loading: boolean
  error: string | null
  onDelete: (id: string) => void
  deleting: boolean
}) {
  if (loading) {
    return (
      <EmptyCard
        title="Loading library…"
        description="Fetching platform MCP servers."
      />
    )
  }
  if (error) {
    return <EmptyCard title="Failed to load library" description={error} tone="danger" />
  }
  if (servers.length === 0) {
    return (
      <EmptyCard
        title="MCP library is empty"
        description="Add a server or install from Marketplace. Library entries are not granted to any agent until you assign them on the Agents tab."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {servers.map((server) => (
        <div
          key={server.id}
          className="rounded-xl border border-primary-200 bg-primary-50/90 p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-ink">{server.name}</p>
              <p className="text-xs text-primary-500">
                {server.transport} · {server.boundAgentCount} agent
                {server.boundAgentCount === 1 ? '' : 's'}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-red-600"
              disabled={deleting}
              onClick={() => onDelete(server.id)}
            >
              Delete
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

function AgentAssignPanel({
  agentId,
  library,
  bindings,
  loading,
  onAssign,
  onToggle,
  onRemove,
  busy,
}: {
  agentId: string
  library: Array<PlatformMcpSummary>
  bindings: Array<{
    serverId: string
    name: string
    enabled: boolean
    transport: string
  }>
  loading: boolean
  onAssign: (serverId: string) => void
  onToggle: (serverId: string, enabled: boolean) => void
  onRemove: (serverId: string) => void
  busy: boolean
}) {
  const boundIds = useMemo(
    () => new Set(bindings.map((b) => b.serverId)),
    [bindings],
  )
  const available = library.filter((s) => !boundIds.has(s.id))

  if (!agentId) {
    return (
      <EmptyCard
        title="Select an agent"
        description="Choose a profile/agent to manage MCP assignments."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-medium text-ink">
          Assigned to {agentId}
        </h3>
        {loading ? (
          <p className="text-sm text-primary-500">Loading…</p>
        ) : bindings.length === 0 ? (
          <EmptyCard
            title="No MCP servers assigned"
            description="Pick a library entry below to grant it to this agent."
          />
        ) : (
          <div className="space-y-1.5">
            {bindings.map((b) => (
              <div
                key={b.serverId}
                className="flex items-center gap-3 rounded-xl border border-primary-200 bg-primary-50/90 px-3 py-2.5"
              >
                <Switch
                  checked={b.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    onToggle(b.serverId, Boolean(checked))
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {b.name}
                  </p>
                  <p className="text-xs text-primary-500">{b.transport}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => onRemove(b.serverId)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-ink">
          Add from library
        </h3>
        {available.length === 0 ? (
          <p className="text-sm text-primary-500">
            {library.length === 0
              ? 'Library is empty — add a server first.'
              : 'All library servers are already assigned to this agent.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {available.map((s) => (
              <Button
                key={s.id}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onAssign(s.id)}
              >
                + {s.name}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface ServerListProps {
  query: ReturnType<typeof useMcpServers>
  onEdit: (server: McpServer) => void
}

function ServerList({ query, onEdit }: ServerListProps) {
  const servers = query.data?.servers ?? []
  if (query.isLoading) {
    return (
      <EmptyCard
        title="Loading servers…"
        description="Fetching MCP servers from the active profile."
      />
    )
  }
  if (query.isError) {
    return (
      <EmptyCard
        title="Failed to load servers"
        description={query.error.message}
        tone="danger"
      />
    )
  }
  if (servers.length === 0) {
    return (
      <EmptyCard
        title="No MCP servers on this profile"
        description="Assign from the Library on the Agents tab, or add a private server."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {servers.map((server) => (
        <McpServerCard key={server.id} server={server} onEdit={onEdit} />
      ))}
    </div>
  )
}

interface EmptyCardProps {
  title: string
  description?: string
  tone?: 'neutral' | 'danger'
}

function EmptyCard({ title, description, tone = 'neutral' }: EmptyCardProps) {
  const toneClasses =
    tone === 'danger'
      ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200'
      : 'border-primary-200 bg-primary-50/80 text-primary-500'
  return (
    <div
      className={`rounded-xl border border-dashed px-4 py-10 text-center ${toneClasses}`}
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="mt-1 text-xs text-primary-500">{description}</p>
      ) : null}
    </div>
  )
}

const TRUST_PILL: Record<string, { label: string; className: string }> = {
  official: {
    label: 'Official',
    className:
      'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300',
  },
  community: {
    label: 'Community',
    className:
      'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  },
  unverified: {
    label: 'Unverified',
    className:
      'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  },
}

function MarketplaceGrid({
  entries,
  loading,
  onInstall,
}: {
  entries: Array<HubMcpEntry>
  loading: boolean
  onInstall: (entry: HubMcpEntry) => void
}) {
  if (loading && entries.length === 0) {
    return (
      <EmptyCard
        title="Searching marketplace…"
        description="Querying configured MCP hub sources."
      />
    )
  }
  if (entries.length === 0) {
    return (
      <EmptyCard
        title="No marketplace results"
        description="Try a different search, or manage Sources."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <AnimatePresence initial={false}>
        {entries.map((entry) => {
          const trust = TRUST_PILL[entry.trust] ?? TRUST_PILL.unverified
          return (
            <motion.div
              key={entry.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-3 rounded-xl border border-primary-200 bg-primary-50/90 p-4"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-ink">{entry.name}</p>
                  <span
                    className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${trust.className}`}
                  >
                    {trust.label}
                  </span>
                </div>
                <p className="text-xs text-primary-500 line-clamp-3">
                  {entry.description || 'No description'}
                </p>
              </div>
              <div className="mt-auto flex items-center justify-between gap-2">
                <span className="text-[11px] text-primary-400">
                  {entry.template?.transportType ?? 'stdio'}
                </span>
                {entry.installed ? (
                  <span className="text-xs text-primary-500">
                    Already installed
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onInstall(entry)}
                  >
                    Add to library
                  </Button>
                )}
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
