import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown01Icon,
  Cancel01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Button } from '@/components/ui/button'
import { fetchModels, type GatewayModelCatalogEntry } from '@/lib/gateway-api'
import {
  CREATE_AGENT_RUNTIMES,
  type CreateAgentInput,
  type CreateAgentRuntime,
  type HermesProfileSetup,
  normalizeAgentId,
} from '@/lib/create-agent'
import { agentRuntimeLabel } from '@/lib/managed-agent-runtime/agent-targets'
import { cn } from '@/lib/utils'
import { AGENT_PRESETS, type AgentPresetCapabilities } from '../agent-presets'

type PresetOption = {
  id: string
  name: string
  emoji: string
  description: string
  systemPrompt: string
  capabilities?: AgentPresetCapabilities
}

const PRESET_OPTIONS: PresetOption[] = [
  {
    id: 'blank',
    name: 'Blank',
    emoji: '✨',
    description: '',
    systemPrompt: '',
  },
  ...Object.entries(AGENT_PRESETS)
    .filter(([id]) => !id.startsWith('pc1-'))
    .map(([id, preset]) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      emoji: preset.emoji,
      description: preset.description,
      systemPrompt: preset.systemPrompt,
      capabilities: preset.capabilities,
    })),
]

type AvailableModel = {
  id: string
  provider: string
  name: string
}

export type CloneAgentOption = {
  id: string
  name: string
  /** Hermes profile id (usually same as agent id). */
  profile: string
  role?: string
  specialty?: string
}

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

  const selected = models.find((model) => model.id === value)

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
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => {
                  onChange(model.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full rounded-xl px-3 py-2.5 text-left text-sm',
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

const SETUP_OPTIONS: Array<{
  id: HermesProfileSetup
  label: string
  hint: string
}> = [
  {
    id: 'new',
    label: 'New profile',
    hint: 'Create ~/.hermes/profiles/<id>',
  },
  {
    id: 'existing',
    label: 'Use existing',
    hint: 'Claim an unbound profile',
  },
  {
    id: 'clone-agent',
    label: 'Clone agent',
    hint: 'Copy profile + roster fields',
  },
]

export function OperationsNewAgentModal({
  open,
  defaultModel,
  /** Unbound Hermes profiles (orphans) for “Use existing”. */
  existingProfiles = [],
  /** Registered Hermes agents for “Clone agent”. */
  cloneAgents = [],
  /** Optional profile seeds when creating a new profile. */
  seedProfiles = [],
  onClose,
  onCreate,
  isSaving,
}: {
  open: boolean
  defaultModel: string
  existingProfiles?: Array<string>
  cloneAgents?: Array<CloneAgentOption>
  seedProfiles?: Array<string>
  onClose: () => void
  onCreate: (input: CreateAgentInput & { emoji?: string }) => Promise<unknown>
  isSaving: boolean
}) {
  const [runtime, setRuntime] = useState<CreateAgentRuntime>('hermes')
  const [hermesSetup, setHermesSetup] = useState<HermesProfileSetup>('new')
  const [presetId, setPresetId] = useState<string>('blank')
  const [presetCapabilities, setPresetCapabilities] =
    useState<AgentPresetCapabilities | null>(null)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [model, setModel] = useState(defaultModel)
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [existingProfile, setExistingProfile] = useState('')
  const [cloneAgentId, setCloneAgentId] = useState('')
  const [role, setRole] = useState('Worker')
  const [specialty, setSpecialty] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')

  useEffect(() => {
    if (!open) return
    setRuntime('hermes')
    setHermesSetup('new')
    setPresetId('blank')
    setPresetCapabilities(null)
    setName('')
    setEmoji('🤖')
    setModel(defaultModel)
    setDescription('')
    setSystemPrompt('')
    setCloneFrom('')
    setExistingProfile('')
    setCloneAgentId('')
    setRole('Worker')
    setSpecialty('')
    setCommand('')
    setArgs('')
  }, [defaultModel, open])

  function applyPreset(next: string) {
    setPresetId(next)
    const preset = PRESET_OPTIONS.find((entry) => entry.id === next)
    if (!preset || preset.id === 'blank') {
      setPresetCapabilities(null)
      return
    }
    setName((current) => current.trim() || preset.name)
    setEmoji(preset.emoji)
    setDescription(preset.description)
    setSystemPrompt(preset.systemPrompt)
    setPresetCapabilities(preset.capabilities ?? null)
  }

  function applyExistingProfile(profileName: string) {
    setExistingProfile(profileName)
    if (!profileName) return
    setName((current) => (current.trim() ? current : profileName))
  }

  function applyCloneAgent(agentId: string) {
    setCloneAgentId(agentId)
    const source = cloneAgents.find((agent) => agent.id === agentId)
    if (!source) return
    setRole(source.role?.trim() || 'Worker')
    setSpecialty(source.specialty ?? '')
    setName((current) =>
      current.trim() ? current : `${source.name}-copy`.slice(0, 48),
    )
  }

  const modelsQuery = useQuery({
    queryKey: ['operations', 'models'],
    queryFn: fetchModels,
    enabled: open && runtime === 'hermes' && hermesSetup !== 'existing',
  })

  /** Fresh orphan list when claiming — don't rely on stale snapshot alone. */
  const orphanProfilesQuery = useQuery({
    queryKey: ['operations', 'orphan-profiles'],
    queryFn: async (): Promise<Array<string>> => {
      const [profilesRes, agentsRes] = await Promise.all([
        fetch('/api/profiles/list?light=1'),
        fetch('/api/agents'),
      ])
      const profilesPayload = (await profilesRes.json().catch(() => ({}))) as {
        profiles?: Array<{ name?: string } | string>
      }
      const agentsPayload = (await agentsRes.json().catch(() => ({}))) as {
        agents?: Array<{
          agentId?: string
          runtime?: string
          runtimeConfig?: { profile?: string }
        }>
      }
      if (!profilesRes.ok) {
        throw new Error(`Failed to list profiles (${profilesRes.status})`)
      }
      const liveNames = (profilesPayload.profiles ?? [])
        .map((entry) =>
          typeof entry === 'string' ? entry : String(entry.name ?? ''),
        )
        .map((name) => name.trim())
        .filter(Boolean)
      const bound = new Set(
        (agentsPayload.agents ?? [])
          .filter((agent) => (agent.runtime || 'hermes') === 'hermes')
          .map(
            (agent) =>
              agent.runtimeConfig?.profile?.trim() ||
              agent.agentId?.trim() ||
              '',
          )
          .filter(Boolean),
      )
      return liveNames
        .filter((name) => name !== 'default' && !bound.has(name))
        .sort((left, right) => left.localeCompare(right))
    },
    enabled: open && runtime === 'hermes',
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const models = useMemo(
    () =>
      (modelsQuery.data?.models ?? [])
        .map(normalizeModel)
        .filter((entry): entry is AvailableModel => Boolean(entry)),
    [modelsQuery.data?.models],
  )

  const orphanProfiles = useMemo(() => {
    const live = orphanProfilesQuery.data
    if (live && live.length > 0) return live
    if (live && live.length === 0) return []
    // While loading / error, fall back to parent snapshot orphans.
    return existingProfiles.filter((profile) => profile !== 'default')
  }, [existingProfiles, orphanProfilesQuery.data])

  const isHermes = runtime === 'hermes'
  const agentIdPreview = normalizeAgentId(name) || 'agent-id'
  const canSubmit =
    Boolean(name.trim()) &&
    (!isHermes ||
      hermesSetup === 'new' ||
      (hermesSetup === 'existing' && Boolean(existingProfile)) ||
      (hermesSetup === 'clone-agent' && Boolean(cloneAgentId)))

  if (!open) return null

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--theme-bg)_48%,transparent)] px-4 py-6"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-[var(--theme-border2)] bg-[var(--theme-card)] p-6 shadow-[0_30px_100px_var(--theme-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] text-[var(--theme-accent)]">
              <HugeiconsIcon icon={PlusSignIcon} size={20} strokeWidth={1.8} />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-[var(--theme-text)]">
                New Agent
              </h2>
              <p className="mt-1 text-sm text-[var(--theme-muted-2)]">
                Registers in the agent roster. Hermes can create, claim, or clone
                a profile.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="control-surface rounded-full p-2 text-[var(--theme-muted)] hover:text-[var(--theme-text)]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={1.8} />
          </button>
        </div>

        <label className="mt-6 block space-y-2">
          <span className="text-sm font-medium text-[var(--theme-text)]">
            Runtime
          </span>
          <select
            value={runtime}
            onChange={(event) =>
              setRuntime(event.target.value as CreateAgentRuntime)
            }
            className="w-full control-surface rounded-2xl px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
          >
            {CREATE_AGENT_RUNTIMES.map((value) => (
              <option key={value} value={value}>
                {agentRuntimeLabel(value)}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4 grid gap-4 md:grid-cols-[1.2fr_0.6fr]">
          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--theme-text)]">
              Name
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Sage"
              className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
            />
            <p className="text-xs text-[var(--theme-muted)]">
              Agent id: <code>{agentIdPreview}</code>
              {isHermes && hermesSetup === 'existing' && existingProfile ? (
                <>
                  {' '}
                  · profile: <code>{existingProfile}</code>
                </>
              ) : null}
              {isHermes && hermesSetup !== 'existing' ? (
                <>
                  {' '}
                  · profile: <code>{agentIdPreview}</code>
                </>
              ) : null}
            </p>
          </label>

          {isHermes ? (
            <label className="space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Emoji
              </span>
              <input
                value={emoji}
                onChange={(event) => setEmoji(event.target.value)}
                placeholder="🐦"
                className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
              />
            </label>
          ) : (
            <label className="space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Role
              </span>
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="Worker"
                className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
              />
            </label>
          )}
        </div>

        {isHermes ? (
          <>
            <div className="mt-6 space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Hermes profile setup
              </span>
              <div className="grid gap-2 sm:grid-cols-3">
                {SETUP_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setHermesSetup(option.id)}
                    className={cn(
                      'rounded-2xl border px-3 py-3 text-left transition-all',
                      hermesSetup === option.id
                        ? 'border-[var(--theme-accent)] bg-[var(--theme-accent-soft)]'
                        : 'border-[var(--theme-border)] bg-[var(--theme-bg)] hover:bg-[var(--theme-card2)]',
                    )}
                  >
                    <div className="text-sm font-medium text-[var(--theme-text)]">
                      {option.label}
                    </div>
                    <div className="mt-1 text-xs text-[var(--theme-muted)]">
                      {option.hint}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {hermesSetup === 'new' ? (
              <>
                <div className="mt-4 space-y-2">
                  <span className="text-sm font-medium text-[var(--theme-text)]">
                    Template
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {PRESET_OPTIONS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(preset.id)}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
                          presetId === preset.id
                            ? 'border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                            : 'border-transparent bg-[var(--theme-input)] text-[var(--theme-muted)] hover:bg-[var(--theme-card2)]',
                        )}
                      >
                        <span aria-hidden="true">{preset.emoji}</span>
                        <span>{preset.name}</span>
                      </button>
                    ))}
                  </div>
                  {presetCapabilities ? (
                    <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2.5">
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--theme-muted)]">
                        Recommended capabilities
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {presetCapabilities.skills.map((skill) => (
                          <span
                            key={skill}
                            className="inline-flex items-center gap-1 rounded-md bg-[var(--theme-accent-soft)] px-2 py-1 text-[11px] text-[var(--theme-text)]"
                          >
                            🧩 {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {seedProfiles.length > 0 ? (
                  <label className="mt-4 block space-y-2">
                    <span className="text-sm font-medium text-[var(--theme-text)]">
                      Seed from profile (optional)
                    </span>
                    <select
                      value={cloneFrom}
                      onChange={(event) => setCloneFrom(event.target.value)}
                      className="w-full control-surface rounded-2xl px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
                    >
                      <option value="">None — blank config</option>
                      {seedProfiles.map((profileName) => (
                        <option key={profileName} value={profileName}>
                          {profileName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </>
            ) : null}

            {hermesSetup === 'existing' ? (
              <div className="mt-4 space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-[var(--theme-text)]">
                    Orphan profiles
                  </span>
                  <span className="text-xs text-[var(--theme-muted)]">
                    {orphanProfilesQuery.isFetching
                      ? 'Refreshing…'
                      : `${orphanProfiles.length} available`}
                  </span>
                </div>
                {orphanProfiles.length > 0 ? (
                  <div className="max-h-56 overflow-y-auto rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-1.5">
                    <ul className="flex flex-col gap-1" role="listbox">
                      {orphanProfiles.map((profileName) => {
                        const selected = existingProfile === profileName
                        return (
                          <li key={profileName}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => applyExistingProfile(profileName)}
                              className={cn(
                                'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
                                selected
                                  ? 'bg-[var(--theme-accent-soft)] text-[var(--theme-text)]'
                                  : 'text-[var(--theme-text)] hover:bg-[var(--transparency-hover)]',
                              )}
                            >
                              <span className="font-medium">{profileName}</span>
                              <span className="text-xs text-[var(--theme-muted)]">
                                ~/.hermes/profiles/{profileName}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ) : (
                  <p className="rounded-2xl border border-dashed border-[var(--theme-border)] px-4 py-3 text-sm text-[var(--theme-muted)]">
                    {orphanProfilesQuery.isFetching
                      ? 'Loading unbound profiles…'
                      : 'No unbound profiles. Create a profile first, or use New profile / Clone agent.'}
                  </p>
                )}
                <p className="text-xs text-[var(--theme-muted)]">
                  Pick an unbound Hermes profile to claim. Binds without copying;
                  only agents.yaml is updated.
                </p>
              </div>
            ) : null}

            {hermesSetup === 'clone-agent' ? (
              <label className="mt-4 block space-y-2">
                <span className="text-sm font-medium text-[var(--theme-text)]">
                  Clone from agent
                </span>
                {cloneAgents.length > 0 ? (
                  <select
                    value={cloneAgentId}
                    onChange={(event) => applyCloneAgent(event.target.value)}
                    className="w-full control-surface rounded-2xl px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
                  >
                    <option value="">Select agent…</option>
                    {cloneAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.id}
                        {agent.profile !== agent.id
                          ? ` → ${agent.profile}`
                          : ''}
                        )
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="rounded-2xl border border-dashed border-[var(--theme-border)] px-4 py-3 text-sm text-[var(--theme-muted)]">
                    No Hermes agents available to clone.
                  </p>
                )}
                <p className="text-xs text-[var(--theme-muted)]">
                  Creates a new profile for this agent id, copies config from the
                  source profile, and copies roster fields (skills / tools /
                  role…).
                </p>
              </label>
            ) : null}

            {hermesSetup !== 'existing' ? (
              <>
                <label className="mt-4 block space-y-2">
                  <span className="text-sm font-medium text-[var(--theme-text)]">
                    Model
                  </span>
                  <ModelSelector
                    value={model}
                    onChange={setModel}
                    models={models}
                  />
                </label>

                <label className="mt-4 block space-y-2">
                  <span className="text-sm font-medium text-[var(--theme-text)]">
                    Description
                  </span>
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
                  />
                </label>

                <label className="mt-4 block space-y-2">
                  <span className="text-sm font-medium text-[var(--theme-text)]">
                    System Prompt
                  </span>
                  <textarea
                    value={systemPrompt}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    className="min-h-[140px] w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
                  />
                </label>
              </>
            ) : null}
          </>
        ) : (
          <>
            <label className="mt-4 block space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Command
              </span>
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder={agentRuntimeLabel(runtime)}
                className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
              />
            </label>
            <label className="mt-4 block space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Arguments
              </span>
              <input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder="Optional"
                className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
              />
            </label>
            <label className="mt-4 block space-y-2">
              <span className="text-sm font-medium text-[var(--theme-text)]">
                Specialty
              </span>
              <input
                value={specialty}
                onChange={(event) => setSpecialty(event.target.value)}
                className="w-full rounded-2xl field-surface px-4 py-3 text-sm text-[var(--theme-text)] outline-none placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)]"
              />
            </label>
          </>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-[var(--theme-accent)] text-primary-950 hover:bg-[var(--theme-accent-strong)]"
            onClick={() =>
              void onCreate({
                name,
                runtime,
                emoji: isHermes ? emoji : undefined,
                hermesSetup: isHermes ? hermesSetup : undefined,
                existingProfile:
                  isHermes && hermesSetup === 'existing'
                    ? existingProfile || undefined
                    : undefined,
                cloneAgentId:
                  isHermes && hermesSetup === 'clone-agent'
                    ? cloneAgentId || undefined
                    : undefined,
                cloneFrom:
                  isHermes && hermesSetup === 'new'
                    ? cloneFrom || undefined
                    : undefined,
                model:
                  isHermes && hermesSetup !== 'existing' ? model : undefined,
                systemPrompt:
                  isHermes && hermesSetup !== 'existing'
                    ? systemPrompt
                    : undefined,
                description:
                  isHermes && hermesSetup !== 'existing'
                    ? description
                    : undefined,
                profile:
                  isHermes && hermesSetup === 'existing'
                    ? existingProfile
                    : isHermes
                      ? agentIdPreview
                      : undefined,
                role,
                specialty: isHermes ? undefined : specialty,
                command: isHermes ? undefined : command || undefined,
                args: isHermes ? undefined : args || undefined,
              }).then(() => onClose())
            }
            disabled={isSaving || !canSubmit}
          >
            {isSaving ? 'Creating…' : 'Create Agent'}
          </Button>
        </div>
      </div>
    </div>
  )
}
