import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  Settings01Icon,
  PuzzleIcon,
  Link01Icon,
  ToolsIcon,
  Folder01Icon,
  Calendar01Icon,
  ViewIcon,
  UserSquareIcon,
  CpuIcon,
  Clock01Icon,
  Alert01Icon,
  AnalyticsUpIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Button } from '@/components/ui/button'
import type { GatewayModelCatalogEntry } from '@/lib/gateway-api'
import { formatRelativeTime } from '@/screens/dashboard/lib/formatters'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import { cn } from '@/lib/utils'
import type {
  OperationsAgent,
  AgentSkillItem,
  AgentMcpItem,
} from '../hooks/use-operations'
import {
  useAssignAgentMcp,
  usePlatformMcpLibrary,
} from '@/screens/mcp/hooks/use-platform-mcp'

/** Per-agent catalog — never the global Hermes /api/models list. */
async function fetchAgentModels(agentId: string): Promise<{
  ok?: boolean
  models?: Array<GatewayModelCatalogEntry>
  currentModel?: string | null
}> {
  const response = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/models`,
  )
  if (!response.ok)
    throw new Error(`Failed to load models (${response.status})`)
  return (await response.json()) as {
    ok?: boolean
    models?: Array<GatewayModelCatalogEntry>
    currentModel?: string | null
  }
}

type AvailableModel = {
  id: string
  provider: string
  name: string
}

type Tab =
  | 'identity'
  | 'model'
  | 'capabilities'
  | 'schedule'
  | 'activity'
  | 'usage'

const TABS: Array<{ id: Tab; label: string; icon: typeof UserSquareIcon }> = [
  { id: 'identity', label: 'Identity', icon: UserSquareIcon },
  { id: 'model', label: 'Model & Provider', icon: CpuIcon },
  { id: 'capabilities', label: 'Capabilities', icon: PuzzleIcon },
  { id: 'schedule', label: 'Schedule', icon: Calendar01Icon },
  { id: 'activity', label: 'Activity', icon: ViewIcon },
  { id: 'usage', label: 'Usage', icon: AnalyticsUpIcon },
]

function normalizeModel(
  model: GatewayModelCatalogEntry,
): AvailableModel | null {
  if (typeof model === 'string') {
    return {
      id: model,
      provider: model.includes('/')
        ? (model.split('/')[0] ?? 'model')
        : 'model',
      name: model.split('/').pop() ?? model,
    }
  }

  const id = model.id ?? model.alias ?? model.model ?? ''
  if (!id) return null

  return {
    id,
    provider: model.provider ?? id.split('/')[0] ?? 'model',
    name:
      model.label ??
      model.displayName ??
      model.name ??
      id.split('/').pop() ??
      id,
  }
}

function ModelSelector({
  value,
  onChange,
  models,
}: {
  value: string
  onChange: (nextValue: string) => void
  models: AvailableModel[]
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const selected = (() => {
    if (!value) return null
    const slashIndex = value.indexOf('/')
    if (slashIndex > 0) {
      const valueProvider = value.slice(0, slashIndex)
      const valueModelId = value.slice(slashIndex + 1)
      const exactMatch = models.find(
        (m) =>
          m.provider === valueProvider &&
          (m.id === value || m.id === valueModelId),
      )
      if (exactMatch) return exactMatch
    }
    const idMatch = models.find((m) => m.id === value)
    if (idMatch) return idMatch
    // Do not fabricate a label for models outside this agent's catalog —
    // that made unsupported defaults (e.g. Kimi) look selected.
    return null
  })()

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="control-surface inline-flex min-h-[3rem] w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-sm text-[var(--theme-text)]"
      >
        <span className="truncate">
          {selected
            ? `${selected.provider} / ${selected.name}`
            : 'Default (auto)'}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={16}
          strokeWidth={1.8}
          className={cn(
            'text-[var(--theme-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+0.5rem)] z-[80] w-full overflow-hidden rounded-2xl border border-[var(--theme-border2)] bg-[var(--theme-card)] shadow-[0_24px_80px_var(--theme-shadow)]">
          <div className="max-h-80 overflow-y-auto p-2">
            <button
              type="button"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className={cn(
                'flex w-full rounded-xl px-3 py-2.5 text-left text-sm',
                !value
                  ? 'bg-[var(--theme-accent-soft)]'
                  : 'hover:bg-[var(--transparency-hover)]',
              )}
            >
              Default (auto)
            </button>
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => {
                  onChange(model.id)
                  setOpen(false)
                }}
                className={cn(
                  'mt-1 flex w-full rounded-xl px-3 py-2.5 text-left text-sm',
                  value === model.id
                    ? 'bg-[var(--theme-accent-soft)]'
                    : 'hover:bg-[var(--transparency-hover)]',
                )}
              >
                {model.provider} / {model.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab content components
// ---------------------------------------------------------------------------

function IdentityTab({
  agentId,
  name,
  emoji,
  description,
  systemPrompt,
  runtime,
  role,
  specialty,
  command,
  args,
  isActiveProfile,
  onName,
  onEmoji,
  onDescription,
  onSystemPrompt,
  onRole,
  onSpecialty,
  onCommand,
  onArgs,
  onActivate,
  isActivating,
  onRename,
  isRenaming,
}: {
  agentId: string
  name: string
  emoji: string
  description: string
  systemPrompt: string
  runtime: string
  role: string
  specialty: string
  command: string
  args: string
  isActiveProfile: boolean
  onName: (v: string) => void
  onEmoji: (v: string) => void
  onDescription: (v: string) => void
  onSystemPrompt: (v: string) => void
  onRole: (v: string) => void
  onSpecialty: (v: string) => void
  onCommand: (v: string) => void
  onArgs: (v: string) => void
  onActivate: () => void
  isActivating: boolean
  onRename: (newName: string) => void
  isRenaming: boolean
}) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(agentId)
  const isHermes = runtime === 'hermes'
  const isDefault = agentId === 'default'

  useEffect(() => {
    setRenameValue(agentId)
    setRenameOpen(false)
  }, [agentId])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
          {agentRuntimeLabel(runtime)}
        </span>
        {isHermes ? (
          isActiveProfile ? (
            <span className="inline-flex items-center rounded-full border border-emerald-300/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
              Active profile
            </span>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={onActivate}
              disabled={isActivating || isDefault}
            >
              {isActivating ? 'Activating…' : 'Activate profile'}
            </Button>
          )
        ) : null}
        {isHermes ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setRenameOpen((v) => !v)}
            disabled={isRenaming || isDefault}
          >
            Rename profile
          </Button>
        ) : null}
      </div>

      {isHermes && renameOpen ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3 sm:flex-row sm:items-center">
          <input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            placeholder="new-profile-id"
            className="w-full rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-2 text-sm outline-none focus:border-[var(--theme-accent)]"
          />
          <Button
            type="button"
            className="bg-[var(--theme-accent)] text-primary-950 hover:bg-[var(--theme-accent-strong)]"
            disabled={isRenaming || !renameValue.trim()}
            onClick={() => onRename(renameValue.trim())}
          >
            {isRenaming ? 'Renaming…' : 'Confirm rename'}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[1.2fr_0.6fr]">
        <label className="space-y-2">
          <span className="text-sm font-medium text-[var(--theme-text)]">
            Display name
          </span>
          <input
            value={name}
            onChange={(event) => onName(event.target.value)}
            disabled={isDefault}
            className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)] disabled:opacity-60"
          />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-[var(--theme-text)]">
            Emoji
          </span>
          <input
            value={emoji}
            onChange={(event) => onEmoji(event.target.value)}
            className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
          />
        </label>
      </div>

      {!isDefault ? (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--theme-text)]">
              Role
            </span>
            <input
              value={role}
              onChange={(event) => onRole(event.target.value)}
              placeholder="Worker"
              className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--theme-text)]">
              Specialty
            </span>
            <input
              value={specialty}
              onChange={(event) => onSpecialty(event.target.value)}
              placeholder="Code review"
              className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
          </label>
        </div>
      ) : null}

      {!isHermes ? (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--theme-text)]">
              Command
            </span>
            <input
              value={command}
              onChange={(event) => onCommand(event.target.value)}
              placeholder={agentRuntimeLabel(runtime)}
              className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--theme-text)]">
              Arguments
            </span>
            <input
              value={args}
              onChange={(event) => onArgs(event.target.value)}
              placeholder="Optional"
              className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
          </label>
        </div>
      ) : null}

      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--theme-text)]">
          Description
        </span>
        <input
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          placeholder="One-line description of what this agent does"
          className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
        />
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--theme-text)]">
          System Prompt
        </span>
        <textarea
          value={systemPrompt}
          onChange={(event) => onSystemPrompt(event.target.value)}
          className="min-h-[220px] w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
        />
      </label>
    </div>
  )
}

function UsageTab({ agent }: { agent: OperationsAgent }) {
  const usage = agent.usage
  if (!usage) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
        Loading usage metrics…
      </div>
    )
  }

  const tiles = [
    { label: 'Sessions', value: String(usage.sessionCount) },
    { label: 'Messages', value: String(usage.messageCount) },
    { label: 'Tool calls', value: String(usage.toolCallCount) },
    { label: 'Tokens', value: usage.totalTokens.toLocaleString() },
    {
      label: 'Est. cost',
      value:
        usage.estimatedCostUsd != null
          ? `$${usage.estimatedCostUsd.toFixed(2)}`
          : '—',
    },
    { label: 'Cron jobs', value: String(usage.cronJobCount) },
    { label: 'Assigned tasks', value: String(usage.assignedTaskCount) },
    {
      label: 'Gateway',
      value: `${usage.gatewayState}${usage.processAlive ? ' · alive' : ''}`,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--theme-muted)]">
              {tile.label}
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--theme-text)]">
              {tile.value}
            </p>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 text-sm text-[var(--theme-muted)]">
        <p>
          Telegram:{' '}
          <span className="text-[var(--theme-text)]">
            {usage.telegramState || 'unknown'}
          </span>
        </p>
        <p className="mt-1">
          Last session:{' '}
          <span className="text-[var(--theme-text)]">
            {usage.lastSessionTitle || '—'}
            {usage.lastSessionAt
              ? ` · ${formatRelativeTime(usage.lastSessionAt)}`
              : ''}
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to="/missions"
            className="rounded-lg border border-[var(--theme-border)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
          >
            View missions
          </Link>
          <a
            href={`/jobs?agent=${encodeURIComponent(agent.id)}`}
            className="rounded-lg border border-[var(--theme-border)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
          >
            View jobs
          </a>
        </div>
      </div>
    </div>
  )
}

function ModelTab({
  model,
  onModel,
  models,
  provider,
  hasProvider,
  hasEnv,
}: {
  model: string
  onModel: (v: string) => void
  models: AvailableModel[]
  provider: string
  hasProvider: boolean
  hasEnv: boolean
}) {
  return (
    <div className="space-y-4">
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--theme-text)]">
          Model
        </span>
        <ModelSelector value={model} onChange={onModel} models={models} />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
            Provider
          </p>
          <p className="mt-1 text-sm text-[var(--theme-text)]">
            {hasProvider ? provider : '— not configured —'}
          </p>
          {!hasProvider && (
            <p className="mt-1 text-xs text-amber-600">
              Set a model to auto-detect provider
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
            .env file
          </p>
          <p className="mt-1 text-sm text-[var(--theme-text)]">
            {hasEnv ? '✓ Found' : '✗ Missing'}
          </p>
          {!hasEnv && (
            <p className="mt-1 text-xs text-[var(--theme-muted)]">
              API keys may not be loaded for this profile
            </p>
          )}
        </div>
      </div>
      <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
        <p className="text-xs text-[var(--theme-muted)]">
          Fallback models and advanced parameters (temperature, max_tokens) can
          be configured by editing the profile's{' '}
          <code className="text-[var(--theme-text)]">config.yaml</code>{' '}
          directly.
        </p>
      </div>
    </div>
  )
}

function CapabilitiesTab({
  agent,
  onToggleSkill,
  isTogglingSkill,
  onToggleMcp,
  isTogglingMcp,
  onRemoveMcp,
  isRemovingMcp,
}: {
  agent: OperationsAgent
  onToggleSkill: (input: {
    profile: string
    name: string
    skillId?: string
    enabled: boolean
  }) => Promise<unknown>
  isTogglingSkill: boolean
  onToggleMcp: (input: {
    profile: string
    server: string
    enabled: boolean
    serverId?: string
  }) => Promise<unknown>
  isTogglingMcp: boolean
  onRemoveMcp: (input: {
    profile: string
    server: string
    serverId?: string
  }) => Promise<unknown>
  isRemovingMcp: boolean
}) {
  const [skillSearch, setSkillSearch] = useState('')
  const [inlineError, setInlineError] = useState<string | null>(null)

  // Local optimistic state — gives immediate visual feedback before the server
  // round-trip completes. Synced from server data whenever capabilities refresh.
  const [localSkills, setLocalSkills] = useState<AgentSkillItem[]>(
    agent.capabilities.skills,
  )
  const [localMcp, setLocalMcp] = useState<AgentMcpItem[]>(
    agent.capabilities.mcpServers,
  )
  const libraryQuery = usePlatformMcpLibrary()
  const assignMcp = useAssignAgentMcp()
  const unboundLibrary = useMemo(() => {
    const configured = new Set(localMcp.map((m) => m.name.toLowerCase()))
    return (libraryQuery.data ?? []).filter(
      (s) => !configured.has(s.name.toLowerCase()),
    )
  }, [libraryQuery.data, localMcp])

  // Keep local state in sync when SWITCHING to a different agent.
  // Intentionally depend on agent.id (not agent.capabilities.skills) because
  // useOperations polls every ~15s and creates a new array reference on each
  // cycle — depending on the array itself would reset localSkills/localMcp on
  // every poll, wiping any in-flight optimistic toggle.
  useEffect(() => {
    setLocalSkills(agent.capabilities.skills)
  }, [agent.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLocalMcp(agent.capabilities.mcpServers)
  }, [agent.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const toolsets = agent.capabilities.toolsets
  const enabledSkills = localSkills.filter((s) => s.enabled)

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return localSkills
    const q = skillSearch.toLowerCase()
    return localSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false) ||
        (s.category?.toLowerCase().includes(q) ?? false),
    )
  }, [localSkills, skillSearch])

  async function handleToggleSkill(skill: AgentSkillItem) {
    setInlineError(null)
    // Optimistic update
    setLocalSkills((prev) =>
      prev.map((s) =>
        s.name === skill.name ? { ...s, enabled: !s.enabled } : s,
      ),
    )
    try {
      await onToggleSkill({
        profile: agent.id,
        name: skill.name,
        skillId: skill.skillId,
        enabled: !skill.enabled,
      })
    } catch (err) {
      // Rollback
      setLocalSkills((prev) =>
        prev.map((s) =>
          s.name === skill.name ? { ...s, enabled: skill.enabled } : s,
        ),
      )
      setInlineError(
        err instanceof Error ? err.message : 'Failed to toggle skill',
      )
    }
  }

  async function handleToggleMcp(mcp: AgentMcpItem) {
    setInlineError(null)
    // Optimistic update
    setLocalMcp((prev) =>
      prev.map((m) =>
        m.name === mcp.name ? { ...m, enabled: !m.enabled } : m,
      ),
    )
    try {
      await onToggleMcp({
        profile: agent.id,
        server: mcp.name,
        enabled: !mcp.enabled,
        serverId: mcp.serverId,
      })
    } catch (err) {
      // Rollback
      setLocalMcp((prev) =>
        prev.map((m) =>
          m.name === mcp.name ? { ...m, enabled: mcp.enabled } : m,
        ),
      )
      setInlineError(
        err instanceof Error ? err.message : 'Failed to toggle MCP server',
      )
    }
  }

  async function handleRemoveMcp(mcp: AgentMcpItem) {
    setInlineError(null)
    if (!confirm(`Remove MCP server "${mcp.name}" from this agent?`)) return
    // Optimistic update
    setLocalMcp((prev) => prev.filter((m) => m.name !== mcp.name))
    try {
      await onRemoveMcp({
        profile: agent.id,
        server: mcp.name,
        serverId: mcp.serverId,
      })
    } catch (err) {
      // Rollback
      setLocalMcp((prev) => [...prev, mcp])
      setInlineError(
        err instanceof Error ? err.message : 'Failed to remove MCP server',
      )
    }
  }

  return (
    <div className="space-y-6">
      {/* Inline error banner */}
      {inlineError ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <HugeiconsIcon
            icon={Alert01Icon}
            size={16}
            strokeWidth={1.8}
            className="mt-0.5 shrink-0"
          />
          <div className="min-w-0">
            <p className="font-medium">Action failed</p>
            <p className="mt-0.5 text-xs">{inlineError}</p>
            {inlineError.includes('503') ||
            inlineError.includes('unavailable') ? (
              <p className="mt-1 text-xs opacity-75">
                Check that the agent profile is available and the local
                workspace control plane is running.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setInlineError(null)}
            className="ml-auto shrink-0 text-amber-600 hover:text-amber-900"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Skills section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              icon={PuzzleIcon}
              size={16}
              strokeWidth={1.8}
              className="text-[var(--theme-accent)]"
            />
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">
              Skills ({enabledSkills.length}/{localSkills.length} enabled)
            </h3>
          </div>
          <Link
            to="/skills"
            className="text-xs text-[var(--theme-accent)] hover:underline"
          >
            Manage in Skills →
          </Link>
        </div>

        {localSkills.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
            No platform skills bound to this agent. Visit the Skills page to
            assign reusable catalog skills.
          </div>
        ) : (
          <>
            <input
              value={skillSearch}
              onChange={(event) => setSkillSearch(event.target.value)}
              placeholder="Search skills..."
              className="w-full rounded-xl field-surface px-3 py-2 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
            <div className="max-h-[280px] space-y-1.5 overflow-y-auto">
              {filteredSkills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-center gap-3 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2.5"
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skill.enabled}
                    aria-label={
                      skill.enabled
                        ? `Disable ${skill.name}`
                        : `Enable ${skill.name}`
                    }
                    onClick={() => void handleToggleSkill(skill)}
                    disabled={isTogglingSkill}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)] disabled:opacity-50',
                      skill.enabled
                        ? 'bg-[var(--theme-accent)]'
                        : 'bg-primary-200',
                    )}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform',
                        skill.enabled ? 'translate-x-4' : 'translate-x-0',
                      )}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-[var(--theme-text)]">
                        {skill.name}
                      </p>
                      {skill.category ? (
                        <span className="shrink-0 rounded-full bg-[var(--theme-card2)] px-2 py-0.5 text-[10px] text-[var(--theme-muted)]">
                          {skill.category}
                        </span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="truncate text-xs text-[var(--theme-muted)]">
                        {skill.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
              {filteredSkills.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-[var(--theme-muted)]">
                  No skills match "{skillSearch}"
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* MCP Servers section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              icon={Link01Icon}
              size={16}
              strokeWidth={1.8}
              className="text-[var(--theme-accent)]"
            />
            <h3 className="text-sm font-semibold text-[var(--theme-text)]">
              MCP Servers ({localMcp.filter((m) => m.enabled).length}/
              {localMcp.length})
            </h3>
          </div>
          <Link
            to="/mcp"
            className="text-xs text-[var(--theme-accent)] hover:underline"
          >
            Assign from library →
          </Link>
        </div>

        {localMcp.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
            No MCP servers on this profile yet. Assign from the{' '}
            <Link to="/mcp" className="text-[var(--theme-accent)] hover:underline">
              MCP library
            </Link>{' '}
            (Agents tab), or add a private server.
          </div>
        ) : (
          <div className="space-y-1.5">
            {localMcp.map((mcp) => (
              <div
                key={mcp.name}
                className="flex items-center gap-3 rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2.5"
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={mcp.enabled}
                  aria-label={
                    mcp.enabled ? `Disable ${mcp.name}` : `Enable ${mcp.name}`
                  }
                  onClick={() => void handleToggleMcp(mcp)}
                  disabled={isTogglingMcp}
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)] disabled:opacity-50',
                    mcp.enabled ? 'bg-[var(--theme-accent)]' : 'bg-primary-200',
                  )}
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform',
                      mcp.enabled ? 'translate-x-4' : 'translate-x-0',
                    )}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--theme-text)]">
                    {mcp.name}
                  </p>
                  {mcp.error ? (
                    <p className="truncate text-xs text-red-500">{mcp.error}</p>
                  ) : (
                    <p className="text-xs text-[var(--theme-muted)]">
                      {mcp.status === 'ok'
                        ? 'Connected'
                        : mcp.status === 'error'
                          ? 'Error'
                          : 'Disabled'}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemoveMcp(mcp)}
                  disabled={isRemovingMcp}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--theme-muted)] transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  aria-label={`Remove ${mcp.name}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {unboundLibrary.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--theme-muted)]">
              Assign from library
            </p>
            <div className="flex flex-wrap gap-2">
              {unboundLibrary.map((server) => (
                <Button
                  key={server.id}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={assignMcp.isPending}
                  onClick={() => {
                    void assignMcp
                      .mutateAsync({
                        agentId: agent.id,
                        serverIds: [server.id],
                      })
                      .then(() => {
                        setLocalMcp((prev) => [
                          ...prev,
                          {
                            name: server.name,
                            enabled: true,
                            status: 'ok',
                            serverId: server.id,
                            source: 'platform',
                          },
                        ])
                      })
                      .catch((err: unknown) => {
                        setInlineError(
                          err instanceof Error
                            ? err.message
                            : 'Failed to assign MCP',
                        )
                      })
                  }}
                >
                  + {server.name}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Toolsets section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={ToolsIcon}
            size={16}
            strokeWidth={1.8}
            className="text-[var(--theme-accent)]"
          />
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">
            Toolsets
          </h3>
        </div>
        {toolsets.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-4 text-sm text-[var(--theme-muted)]">
            No toolsets explicitly enabled — this profile uses the default
            toolset.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {toolsets.map((toolset) => (
              <span
                key={toolset}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text)]"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {toolset}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Resources section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={16}
            strokeWidth={1.8}
            className="text-[var(--theme-accent)]"
          />
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">
            Resources
          </h3>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
              Workspace
            </p>
            <p
              className="mt-1 truncate text-sm text-[var(--theme-text)]"
              title={agent.resources.workspace}
            >
              {agent.resources.workspace || '— not set —'}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
              .env file
            </p>
            <p className="mt-1 text-sm text-[var(--theme-text)]">
              {agent.resources.envExists ? '✓ Found' : '✗ Missing'}
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

function ScheduleTab({
  agent,
  onClose,
}: {
  agent: OperationsAgent
  onClose: () => void
}) {
  const jobs = agent.jobs

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">
            Scheduled Jobs
          </h3>
          <p className="mt-1 text-xs text-[var(--theme-muted)]">
            Cron jobs tagged with <code>ops:{agent.id}:*</code>
          </p>
        </div>
        <Link
          to="/jobs"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-xl border border-transparent bg-[var(--theme-input)] px-3 py-2 text-xs font-medium text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
        >
          + Add Job
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
          No scheduled jobs for this agent yet.
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex flex-col gap-2 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      job.enabled ? 'bg-emerald-500' : 'bg-primary-300',
                    )}
                  />
                  <p className="text-sm font-medium text-[var(--theme-text)]">
                    {job.name
                      .replace(`ops:${agent.id}:`, '')
                      .replace(/-/g, ' ')}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-[var(--theme-muted)]">
                  {job.description || job.schedule}
                </p>
              </div>
              <div className="text-xs text-[var(--theme-muted)] md:text-right">
                <p className="inline-flex items-center gap-1.5">
                  <HugeiconsIcon
                    icon={Clock01Icon}
                    size={12}
                    strokeWidth={1.8}
                  />
                  {job.schedule}
                </p>
                <p className="mt-0.5">
                  {job.nextRunAt
                    ? `Next ${formatRelativeTime(new Date(job.nextRunAt).getTime())}`
                    : job.lastRun?.startedAt
                      ? `Last ${formatRelativeTime(new Date(job.lastRun.startedAt).getTime())}`
                      : 'No runs yet'}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActivityTab({ agent }: { agent: OperationsAgent }) {
  const outputs = agent.recentOutputs
  const sessions = agent.sessions

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--theme-text)]">
          Recent Outputs
        </h3>
        <p className="mt-1 text-xs text-[var(--theme-muted)]">
          Latest session and cron outputs from this agent
        </p>
      </div>

      {outputs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-6 text-sm text-[var(--theme-muted)]">
          No recent activity yet.
        </div>
      ) : (
        <div className="space-y-2">
          {outputs.map((output) => (
            <div
              key={output.id}
              className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    output.source === 'cron'
                      ? 'bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                      : 'bg-[var(--theme-card2)] text-[var(--theme-muted)]',
                  )}
                >
                  {output.source}
                </span>
                <span className="text-xs text-[var(--theme-muted)]">
                  {formatRelativeTime(output.timestamp)}
                </span>
              </div>
              <p className="mt-2 text-sm text-[var(--theme-text)]">
                {output.summary}
              </p>
            </div>
          ))}
        </div>
      )}

      {sessions.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wider text-[var(--theme-muted)]">
            Sessions ({sessions.length})
          </h4>
          {sessions.slice(0, 10).map((session) => (
            <a
              key={session.key}
              href={`/chat?session=${encodeURIComponent(session.key ?? '')}`}
              className="block rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-4 py-2.5 transition-colors hover:border-[var(--theme-accent)]"
            >
              <p className="truncate text-sm text-[var(--theme-text)]">
                {session.title || session.initialMessage || session.key}
              </p>
              <p className="mt-0.5 text-xs text-[var(--theme-muted)]">
                {session.status} ·{' '}
                {session.updatedAt
                  ? formatRelativeTime(new Date(session.updatedAt).getTime())
                  : 'unknown'}
              </p>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OperationsAgentDetail({
  open,
  agent,
  onClose,
  onSave,
  onDelete,
  onActivate,
  isActivating,
  onRename,
  isRenaming,
  isSaving,
  isDeleting,
  onToggleSkill,
  isTogglingSkill,
  onToggleMcp,
  isTogglingMcp,
  onRemoveMcp,
  isRemovingMcp,
}: {
  open: boolean
  agent: OperationsAgent | null
  onClose: () => void
  onSave: (input: {
    agentId: string
    name: string
    model: string
    emoji: string
    systemPrompt: string
    description?: string
    role?: string
    specialty?: string
    command?: string
    args?: string
  }) => Promise<unknown>
  onDelete: (agentId: string) => Promise<unknown>
  onActivate: (agentId: string) => Promise<unknown>
  isActivating: boolean
  onRename: (input: {
    oldName: string
    newName: string
  }) => Promise<unknown>
  isRenaming: boolean
  isSaving: boolean
  isDeleting: boolean
  onToggleSkill: (input: {
    profile: string
    name: string
    skillId?: string
    enabled: boolean
  }) => Promise<unknown>
  isTogglingSkill: boolean
  onToggleMcp: (input: {
    profile: string
    server: string
    enabled: boolean
    serverId?: string
  }) => Promise<unknown>
  isTogglingMcp: boolean
  onRemoveMcp: (input: {
    profile: string
    server: string
    serverId?: string
  }) => Promise<unknown>
  isRemovingMcp: boolean
}) {
  const [activeTab, setActiveTab] = useState<Tab>('identity')
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [description, setDescription] = useState('')
  const [role, setRole] = useState('Worker')
  const [specialty, setSpecialty] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')

  // Reset form fields + active tab ONLY when the agent ID changes or panel opens.
  // We intentionally depend on agent?.id (a string) rather than the agent object
  // itself, because useOperations polls every ~15s and produces a new agent object
  // reference on each cycle — depending on `agent` would reset activeTab to
  // 'identity' every time the background data refreshes.
  useEffect(() => {
    if (!agent || !open) return
    setName(agent.name)
    setEmoji(agent.meta.emoji)
    setModel(agent.model || '')
    setSystemPrompt(agent.meta.systemPrompt)
    setDescription(agent.meta.description || agent.description || '')
    setRole(agent.role || 'Worker')
    setSpecialty(agent.specialty || '')
    setCommand(agent.command || '')
    setArgs(agent.args?.join(' ') || '')
    setActiveTab('identity')
  }, [agent?.id, open])

  const modelsQuery = useQuery({
    queryKey: ['operations', 'models', agent?.id ?? ''],
    queryFn: () => fetchAgentModels(agent!.id),
    enabled: open && Boolean(agent?.id),
  })

  const models = useMemo(() => {
    return (modelsQuery.data?.models ?? [])
      .map(normalizeModel)
      .filter((entry): entry is AvailableModel => Boolean(entry))
  }, [modelsQuery.data?.models])

  // Keep the form value on a model that actually exists for this agent.
  useEffect(() => {
    if (!open || !agent) return
    if (!modelsQuery.isFetched) return
    const catalogIds = new Set(models.map((m) => m.id))
    const apiCurrent = modelsQuery.data?.currentModel?.trim() || ''
    const current = model.trim()
    if (current && catalogIds.has(current)) return
    const preferred =
      (apiCurrent && catalogIds.has(apiCurrent) && apiCurrent) ||
      (agent.model?.trim() &&
        catalogIds.has(agent.model.trim()) &&
        agent.model.trim()) ||
      apiCurrent ||
      ''
    if (preferred !== current) setModel(preferred)
  }, [
    agent,
    model,
    models,
    modelsQuery.data?.currentModel,
    modelsQuery.isFetched,
    open,
  ])

  if (!open || !agent) return null

  function handleSave() {
    void onSave({
      agentId: agent!.id,
      name,
      model,
      emoji,
      systemPrompt,
      description,
      role,
      specialty,
      command,
      args,
    })
  }

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--theme-bg)_55%,transparent)] px-4 py-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-3xl border border-[var(--theme-border2)] bg-[var(--theme-card)] shadow-[0_24px_80px_var(--theme-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--theme-border)] px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-accent)]">
              <HugeiconsIcon
                icon={Settings01Icon}
                size={20}
                strokeWidth={1.8}
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--theme-muted)]">
                Agent Settings
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--theme-text)]">
                {agent.meta.emoji} {agent.name}
              </h2>
              <p className="mt-1 text-sm text-[var(--theme-muted-2)]">
                {agent.meta.description ||
                  agent.description ||
                  'No description'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-10 items-center justify-center rounded-xl border border-[var(--theme-border)] bg-[var(--theme-card2)] text-lg text-[var(--theme-muted)] transition-colors hover:border-[var(--theme-accent)] hover:text-[var(--theme-accent-strong)]"
            aria-label="Close agent settings"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={1.8} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--theme-border)] px-5 py-2 sm:px-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                  : 'text-[var(--theme-muted)] hover:bg-[var(--theme-bg)] hover:text-[var(--theme-text)]',
              )}
            >
              <HugeiconsIcon icon={tab.icon} size={14} strokeWidth={1.8} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {activeTab === 'identity' ? (
            <IdentityTab
              agentId={agent.id}
              name={name}
              emoji={emoji}
              description={description}
              systemPrompt={systemPrompt}
              runtime={agent.runtime || 'hermes'}
              role={role}
              specialty={specialty}
              command={command}
              args={args}
              isActiveProfile={agent.isActiveProfile}
              onName={setName}
              onEmoji={setEmoji}
              onDescription={setDescription}
              onSystemPrompt={setSystemPrompt}
              onRole={setRole}
              onSpecialty={setSpecialty}
              onCommand={setCommand}
              onArgs={setArgs}
              onActivate={() => void onActivate(agent.id)}
              isActivating={isActivating}
              onRename={(newName) =>
                void onRename({ oldName: agent.id, newName })
              }
              isRenaming={isRenaming}
            />
          ) : activeTab === 'model' ? (
            <ModelTab
              model={model}
              onModel={setModel}
              models={models}
              provider={agent.provider || ''}
              hasProvider={agent.health.hasProvider}
              hasEnv={agent.resources.envExists}
            />
          ) : activeTab === 'capabilities' ? (
            <CapabilitiesTab
              agent={agent}
              onToggleSkill={onToggleSkill}
              isTogglingSkill={isTogglingSkill}
              onToggleMcp={onToggleMcp}
              isTogglingMcp={isTogglingMcp}
              onRemoveMcp={onRemoveMcp}
              isRemovingMcp={isRemovingMcp}
            />
          ) : activeTab === 'schedule' ? (
            <ScheduleTab agent={agent} onClose={onClose} />
          ) : activeTab === 'usage' ? (
            <UsageTab agent={agent} />
          ) : (
            <ActivityTab agent={agent} />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--theme-border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Button
            variant="ghost"
            className="justify-start text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={() => void onDelete(agent.id)}
            disabled={isDeleting || isSaving}
          >
            <HugeiconsIcon icon={Delete02Icon} size={16} strokeWidth={1.8} />
            {isDeleting ? 'Deleting…' : 'Delete agent'}
          </Button>
          <div className="flex justify-end gap-3">
            <Button
              variant="secondary"
              className="border-transparent bg-[var(--theme-input)] text-[var(--theme-text)] hover:bg-[var(--theme-card2)]"
              onClick={onClose}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              className="bg-[var(--theme-accent)] text-primary-950 hover:bg-[var(--theme-accent-strong)]"
              onClick={handleSave}
              disabled={isSaving || isDeleting}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
