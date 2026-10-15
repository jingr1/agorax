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

export function OperationsNewAgentModal({
  open,
  defaultModel,
  cloneOptions = [],
  onClose,
  onCreate,
  isSaving,
}: {
  open: boolean
  defaultModel: string
  cloneOptions?: Array<{ id: string; name: string }>
  onClose: () => void
  onCreate: (input: CreateAgentInput & { emoji?: string }) => Promise<unknown>
  isSaving: boolean
}) {
  const [runtime, setRuntime] = useState<CreateAgentRuntime>('hermes')
  const [presetId, setPresetId] = useState<string>('blank')
  const [presetCapabilities, setPresetCapabilities] =
    useState<AgentPresetCapabilities | null>(null)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [model, setModel] = useState(defaultModel)
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [role, setRole] = useState('Worker')
  const [specialty, setSpecialty] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')

  useEffect(() => {
    if (!open) return
    setRuntime('hermes')
    setPresetId('blank')
    setPresetCapabilities(null)
    setName('')
    setEmoji('🤖')
    setModel(defaultModel)
    setDescription('')
    setSystemPrompt('')
    setCloneFrom('')
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

  const modelsQuery = useQuery({
    queryKey: ['operations', 'models'],
    queryFn: fetchModels,
    enabled: open && runtime === 'hermes',
  })

  const models = useMemo(
    () =>
      (modelsQuery.data?.models ?? [])
        .map(normalizeModel)
        .filter((entry): entry is AvailableModel => Boolean(entry)),
    [modelsQuery.data?.models],
  )

  const isHermes = runtime === 'hermes'
  const agentIdPreview = normalizeAgentId(name) || 'agent-id'

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
                Registers in the agent roster. Hermes also creates a profile via
                /api/profiles/create.
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
              <p className="text-xs text-[var(--theme-muted)]">
                Creates <code>~/.hermes/profiles/{agentIdPreview}</code> through{' '}
                <code>POST /api/profiles/create</code>, then registers the agent.
              </p>
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

            {cloneOptions.length > 0 ? (
              <label className="mt-4 block space-y-2">
                <span className="text-sm font-medium text-[var(--theme-text)]">
                  Clone from existing profile
                </span>
                <select
                  value={cloneFrom}
                  onChange={(event) => setCloneFrom(event.target.value)}
                  className="w-full control-surface rounded-2xl px-4 py-3 text-sm text-[var(--theme-text)] outline-none focus:border-[var(--theme-accent)]"
                >
                  <option value="">None — start blank / from template</option>
                  {cloneOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} ({option.id})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

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
                model: isHermes ? model : undefined,
                systemPrompt: isHermes ? systemPrompt : undefined,
                description: isHermes ? description : undefined,
                cloneFrom: isHermes ? cloneFrom || undefined : undefined,
                profile: isHermes ? agentIdPreview : undefined,
                role,
                specialty: isHermes ? undefined : specialty,
                command: isHermes ? undefined : command || undefined,
                args: isHermes ? undefined : args || undefined,
              }).then(() => onClose())
            }
            disabled={isSaving || !name.trim()}
          >
            {isSaving ? 'Creating…' : 'Create Agent'}
          </Button>
        </div>
      </div>
    </div>
  )
}
