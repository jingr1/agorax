'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CloudIcon,
  Settings02Icon,
  SourceCodeSquareIcon,
} from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import {
  SETTINGS_CONTROL_CLASS,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-section'
import { cn } from '@/lib/utils'

/** Fixed provider id: talk to Anthropic's official API, no base URL override, no catalog key. */
const DIRECT_ANTHROPIC_ID = '__anthropic_direct__'
/** Fixed provider id: freeform base URL / key entry, not backed by a catalog entry. */
const CUSTOM_PROVIDER_ID = '__custom__'

const DEFAULT_MODEL_ALIASES = [
  { id: 'default', label: 'default — account recommended' },
  { id: 'best', label: 'best — Fable 5 or latest Opus' },
  { id: 'fable', label: 'fable — Claude Fable 5' },
  { id: 'opus', label: 'opus — complex reasoning' },
  { id: 'sonnet', label: 'sonnet — daily coding' },
  { id: 'haiku', label: 'haiku — quick tasks' },
  { id: 'opusplan', label: 'opusplan — plan with opus, execute with sonnet' },
  { id: 'opus[1m]', label: 'opus[1m] — Opus with 1M context' },
  { id: 'sonnet[1m]', label: 'sonnet[1m] — Sonnet with 1M context' },
]

/** Fallback ids for direct Anthropic, used only when Hermes has no catalog entry/models for it. */
const ANTHROPIC_MODEL_IDS: Record<string, Array<string>> = {
  fable: ['claude-fable-5'],
  opus: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'],
  sonnet: ['claude-sonnet-4-6', 'claude-sonnet-4-5'],
  haiku: ['claude-haiku-4-5', 'claude-haiku-3-5'],
}

/**
 * Claude Code's Anthropic client appends `/v1/messages` to ANTHROPIC_BASE_URL.
 * Hermes provider catalog entries often end in `/v1` because they are consumed
 * by OpenAI-compatible clients. Strip a trailing `/v1` so the final URL is
 * correct for Claude Code.
 */
function normalizeClaudeBaseUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  // Strip exactly one trailing /v1 (with or without slash).
  return trimmed.replace(/\/v1\/?$/, '')
}

const SUBAGENT_OPTIONS = [
  { id: 'haiku', label: 'haiku — fast/cheap' },
  { id: 'sonnet', label: 'sonnet — balanced' },
  { id: 'opus', label: 'opus — capable' },
  { id: 'fable', label: 'fable — most capable' },
  { id: 'inherit', label: 'inherit — use session model' },
]

type AliasPin = {
  alias: string
  envKey: string
  label: string
}

const ALIAS_PINS: Array<AliasPin> = [
  { alias: 'opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL', label: 'Opus' },
  { alias: 'sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL', label: 'Sonnet' },
  { alias: 'haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', label: 'Haiku' },
  { alias: 'fable', envKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL', label: 'Fable' },
]

type EnvDraft = {
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
  ANTHROPIC_DEFAULT_FABLE_MODEL?: string
  CLAUDE_CODE_SUBAGENT_MODEL?: string
}

type AuthMode = 'api_key' | 'auth_token'

type SettingsSnapshot = {
  model?: string
  currentModel?: string
  currentProvider?: string
  env: EnvDraft
}

/** A provider configured on the Hermes "Model & Provider" page. */
type CatalogProviderLite = {
  id: string
  name: string
  baseUrl: string
  models: Array<string>
  keyConfigured: boolean
  maskedKey: string
}

/** Sentinel shown in secret fields after a catalog copy — never a real secret. */
const SECRET_MASK = '••••'

/** Direct Anthropic uses API key; gateways/proxies use auth token. */
function inferAuthMode(providerId: string): AuthMode {
  return providerId === DIRECT_ANTHROPIC_ID || providerId === 'anthropic'
    ? 'api_key'
    : 'auth_token'
}

/**
 * Model ids selectable for an alias pin: the selected provider's configured
 * models when there are any, else the built-in Anthropic id list for the
 * direct-Anthropic option, else empty (user types a custom id).
 */
function pinModelOptions(
  alias: string,
  selectedProvider: string,
  selectedProviderModels: Array<string>,
): Array<string> {
  if (selectedProviderModels.length) return selectedProviderModels
  if (selectedProvider === DIRECT_ANTHROPIC_ID) {
    return ANTHROPIC_MODEL_IDS[alias] ?? []
  }
  return []
}

export type ClaudeCodeSettingsPanelProps = {
  /** Optional agent id — included in mutation metadata and saves. */
  agentId?: string
  /** Called after a successful save so parents can refresh dependent state. */
  onSaved?: () => void
}

export const CLAUDE_CODE_SETTINGS_QUERY_KEY = [
  'claude-code',
  'settings',
] as const

type ClaudeCodeSettingsResponse = {
  settings?: { model?: string; env?: EnvDraft }
  currentModel?: string
  currentProvider?: string
  catalogProviders?: Array<CatalogProviderLite>
  error?: string
}

export async function fetchClaudeCodeSettings(): Promise<ClaudeCodeSettingsResponse> {
  const res = await fetch('/api/claude-code/settings')
  const data = (await res.json()) as ClaudeCodeSettingsResponse
  if (!res.ok) {
    throw new Error(data.error || 'Failed to load settings')
  }
  return data
}

export function ClaudeCodeSettingsPanel({
  agentId,
  onSaved,
}: ClaudeCodeSettingsPanelProps) {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: CLAUDE_CODE_SETTINGS_QUERY_KEY,
    queryFn: fetchClaudeCodeSettings,
    staleTime: 60_000,
  })
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [selectedProvider, setSelectedProvider] = useState(DIRECT_ANTHROPIC_ID)
  const [envDraft, setEnvDraft] = useState<EnvDraft>({})
  const [customPins, setCustomPins] = useState<Record<string, string>>({})
  const [catalogProviders, setCatalogProviders] = useState<
    Array<CatalogProviderLite>
  >([])
  const [hydrated, setHydrated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  /** API key (direct Anthropic) vs auth token (proxy/gateway). */
  const [authMode, setAuthMode] = useState<AuthMode>('api_key')
  /** Only for Direct / Custom — catalog keys are copied server-side on Save. */
  const [secretDraft, setSecretDraft] = useState('')
  const [secretDirty, setSecretDirty] = useState(false)

  const baseUrlDraft = envDraft.ANTHROPIC_BASE_URL?.trim() || ''
  const isCatalogProvider =
    selectedProvider !== DIRECT_ANTHROPIC_ID &&
    selectedProvider !== CUSTOM_PROVIDER_ID

  // "Anthropic" always gets its own top slot — either the Hermes catalog
  // entry (if the user configured a key for it there) or a plain direct
  // option with no catalog backing. Every other configured provider follows,
  // then a manual/custom fallback for anything not in the catalog.
  const anthropicCatalogEntry = useMemo(
    () => catalogProviders.find((p) => p.id === 'anthropic') ?? null,
    [catalogProviders],
  )
  const otherCatalogProviders = useMemo(
    () => catalogProviders.filter((p) => p.id !== 'anthropic'),
    [catalogProviders],
  )
  const providerOptions = useMemo(() => {
    const anthropicOption = {
      id: anthropicCatalogEntry ? 'anthropic' : DIRECT_ANTHROPIC_ID,
      name: 'Anthropic API',
      catalog: anthropicCatalogEntry,
    }
    const catalogOptions = otherCatalogProviders.map((p) => ({
      id: p.id,
      name: p.name,
      catalog: p,
    }))
    const customOption = {
      id: CUSTOM_PROVIDER_ID,
      name: 'Custom / 手动填写',
      catalog: null as CatalogProviderLite | null,
    }
    return [anthropicOption, ...catalogOptions, customOption]
  }, [anthropicCatalogEntry, otherCatalogProviders])

  const selectedCatalogEntry = useMemo(
    () => providerOptions.find((o) => o.id === selectedProvider)?.catalog ?? null,
    [providerOptions, selectedProvider],
  )

  const modelIsCustom = useMemo(
    () =>
      selectedModel === '__custom__' ||
      (!DEFAULT_MODEL_ALIASES.some((a) => a.id === selectedModel) &&
        selectedModel !== ''),
    [selectedModel],
  )

  const effectiveModel = useMemo(() => {
    if (selectedModel === '__custom__') return customModel.trim()
    return selectedModel
  }, [selectedModel, customModel])

  /**
   * Live preview of what `settings.model` resolves to given the current draft.
   * Mirrors `expandClaudeCodeModelAlias` server-side logic so the readout
   * updates before the user hits Save.
   */
  const resolvedModelPreview = useMemo(() => {
    const alias = effectiveModel.trim().toLowerCase()
    if (!alias) return ''
    for (const { alias: candidate, envKey } of ALIAS_PINS) {
      if (alias === candidate) {
        const fromPin = customPins[envKey]
        const fromEnv = envDraft[envKey as keyof EnvDraft]
        const pinned =
          (typeof fromPin === 'string' ? fromPin.trim() : '') ||
          (typeof fromEnv === 'string' ? fromEnv.trim() : '')
        if (pinned) return pinned
      }
    }
    return effectiveModel
  }, [effectiveModel, envDraft, customPins])

  useEffect(() => {
    if (settingsQuery.isError) {
      setMsg(
        settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : 'Failed to load settings',
      )
      return
    }
    const snapshot = settingsQuery.data
    if (!snapshot) return

    const currentModel = snapshot.settings?.model || ''
    const env = snapshot.settings?.env ?? {}
    const baseUrl = normalizeClaudeBaseUrl(env.ANTHROPIC_BASE_URL || '')
    const catalog = snapshot.catalogProviders ?? []

    setSettings({
      model: snapshot.settings?.model,
      currentModel: snapshot.currentModel,
      currentProvider: snapshot.currentProvider,
      env,
    })
    setEnvDraft(env)
    setCatalogProviders(catalog)

    const anthropicEntry = catalog.find((p) => p.id === 'anthropic')
    let provider = CUSTOM_PROVIDER_ID
    if (!baseUrl) {
      provider = anthropicEntry ? 'anthropic' : DIRECT_ANTHROPIC_ID
    } else {
      const match = catalog.find(
        (p) =>
          p.baseUrl.trim() && normalizeClaudeBaseUrl(p.baseUrl) === baseUrl,
      )
      if (match) provider = match.id
    }
    setSelectedProvider(provider)

    // AUTH_TOKEN wins when both exist — that's the proxy/gateway pattern.
    const hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim())
    const hasApiKey = Boolean(env.ANTHROPIC_API_KEY?.trim())
    setAuthMode(
      hasAuthToken
        ? 'auth_token'
        : hasApiKey
          ? 'api_key'
          : inferAuthMode(provider),
    )
    setSecretDraft(hasAuthToken || hasApiKey ? SECRET_MASK : '')
    setSecretDirty(false)

    const providerModels =
      provider === CUSTOM_PROVIDER_ID || provider === DIRECT_ANTHROPIC_ID
        ? []
        : (catalog.find((p) => p.id === provider)?.models ?? [])
    const custom: Record<string, string> = {}
    for (const { alias, envKey } of ALIAS_PINS) {
      const value = env[envKey as keyof EnvDraft]?.trim() || ''
      const known = pinModelOptions(alias, provider, providerModels)
      if (value && !known.includes(value)) {
        custom[envKey] = value
      }
    }
    setCustomPins(custom)

    if (
      currentModel &&
      DEFAULT_MODEL_ALIASES.some((a) => a.id === currentModel)
    ) {
      setSelectedModel(currentModel)
      setCustomModel('')
    } else if (currentModel) {
      setSelectedModel('__custom__')
      setCustomModel(currentModel)
    }
    setHydrated(true)
  }, [agentId, settingsQuery.data, settingsQuery.error, settingsQuery.isError])

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const mergedEnv: EnvDraft = { ...envDraft }
      for (const { envKey } of ALIAS_PINS) {
        const custom = (customPins[envKey] || '').trim()
        if (custom) {
          mergedEnv[envKey as keyof EnvDraft] = custom
        }
      }

      const envPatch: Record<string, string | null | undefined> = {
        ANTHROPIC_DEFAULT_OPUS_MODEL:
          mergedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || null,
        ANTHROPIC_DEFAULT_SONNET_MODEL:
          mergedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || null,
        ANTHROPIC_DEFAULT_HAIKU_MODEL:
          mergedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || null,
        ANTHROPIC_DEFAULT_FABLE_MODEL:
          mergedEnv.ANTHROPIC_DEFAULT_FABLE_MODEL?.trim() || null,
        CLAUDE_CODE_SUBAGENT_MODEL:
          mergedEnv.CLAUDE_CODE_SUBAGENT_MODEL?.trim() || null,
      }

      const body: {
        model?: string | null
        env?: Record<string, string | null | undefined>
        copyFromCatalogProvider?: string
        authMode?: AuthMode
      } = {
        model: effectiveModel || null,
        env: envPatch,
      }

      if (isCatalogProvider) {
        // Codex-style: pick a catalog entry → Save copies URL + key server-side.
        // authMode chooses which Claude env slot receives the Hermes secret.
        body.copyFromCatalogProvider = selectedProvider
        body.authMode = authMode
      } else if (selectedProvider === DIRECT_ANTHROPIC_ID) {
        envPatch.ANTHROPIC_BASE_URL = null
        if (secretDirty) {
          if (authMode === 'auth_token') {
            envPatch.ANTHROPIC_AUTH_TOKEN = secretDraft.trim() || null
            envPatch.ANTHROPIC_API_KEY = null
          } else {
            envPatch.ANTHROPIC_API_KEY = secretDraft.trim() || null
            envPatch.ANTHROPIC_AUTH_TOKEN = null
          }
        }
      } else {
        // Custom gateway: freeform base URL + secret.
        envPatch.ANTHROPIC_BASE_URL =
          normalizeClaudeBaseUrl(baseUrlDraft) || null
        if (secretDirty) {
          if (authMode === 'auth_token') {
            envPatch.ANTHROPIC_AUTH_TOKEN = secretDraft.trim() || null
            envPatch.ANTHROPIC_API_KEY = null
          } else {
            envPatch.ANTHROPIC_API_KEY = secretDraft.trim() || null
            envPatch.ANTHROPIC_AUTH_TOKEN = null
          }
        }
      }

      const res = await fetch('/api/claude-code/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        settings?: { env?: EnvDraft }
        currentModel?: string
        currentProvider?: string
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Save failed')
      }
      const nextEnv = data.settings?.env ?? envDraft
      setEnvDraft(nextEnv)
      setSecretDraft(
        nextEnv.ANTHROPIC_AUTH_TOKEN?.trim() ||
          nextEnv.ANTHROPIC_API_KEY?.trim()
          ? SECRET_MASK
          : '',
      )
      setSecretDirty(false)
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              model: effectiveModel,
              currentModel: data.currentModel,
              currentProvider: data.currentProvider,
              env: nextEnv,
            }
          : prev,
      )
      setMsg('Saved')

      void queryClient.invalidateQueries({
        queryKey: ['claude-code', 'models'],
      })
      void queryClient.setQueryData(CLAUDE_CODE_SETTINGS_QUERY_KEY, {
        settings: { model: effectiveModel, env: nextEnv },
        currentModel: data.currentModel,
        currentProvider: data.currentProvider,
        catalogProviders,
      })

      onSaved?.()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  if (!hydrated && (settingsQuery.isLoading || settingsQuery.isFetching)) {
    return (
      <div className="space-y-4">
        <div className="h-36 animate-pulse rounded-2xl bg-primary-100/70" />
        <div className="h-28 animate-pulse rounded-2xl bg-primary-100/70" />
        <div className="h-40 animate-pulse rounded-2xl bg-primary-100/70" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {msg ? (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            msg.includes('Failed') || msg.includes('fail')
              ? 'bg-red-500/15 text-red-500 dark:text-red-400'
              : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          )}
        >
          {msg}
        </div>
      ) : null}

      <SettingsSection
        title="Provider"
        description="Selecting a Hermes catalog entry copies its base URL and key into ~/.claude/settings.json on Save."
        icon={CloudIcon}
      >
        <SettingsRow stacked label="Provider">
          <select
            value={selectedProvider}
            onChange={(e) => {
              const id = e.target.value
              setSelectedProvider(id)
              setAuthMode(inferAuthMode(id))
              setSecretDirty(false)
              if (id === DIRECT_ANTHROPIC_ID) {
                setEnvDraft((prev) => ({ ...prev, ANTHROPIC_BASE_URL: '' }))
                setSecretDraft(
                  envDraft.ANTHROPIC_API_KEY?.trim() ||
                    envDraft.ANTHROPIC_AUTH_TOKEN?.trim()
                    ? SECRET_MASK
                    : '',
                )
              } else if (id === CUSTOM_PROVIDER_ID) {
                setSecretDraft(
                  envDraft.ANTHROPIC_AUTH_TOKEN?.trim() ||
                    envDraft.ANTHROPIC_API_KEY?.trim()
                    ? SECRET_MASK
                    : '',
                )
              } else {
                const entry = catalogProviders.find((p) => p.id === id)
                setEnvDraft((prev) => ({
                  ...prev,
                  ANTHROPIC_BASE_URL: normalizeClaudeBaseUrl(
                    entry?.baseUrl || '',
                  ),
                }))
              }
            }}
            className={SETTINGS_CONTROL_CLASS}
          >
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.catalog
                  ? ''
                  : p.id === DIRECT_ANTHROPIC_ID
                    ? ' (direct)'
                    : ''}
              </option>
            ))}
          </select>
        </SettingsRow>

        {isCatalogProvider && selectedCatalogEntry?.baseUrl ? (
          <p className="text-xs text-primary-600">
            {selectedCatalogEntry.keyConfigured
              ? `Will copy ${selectedCatalogEntry.baseUrl} and key (${selectedCatalogEntry.maskedKey}) into the Auth slot below.`
              : `Will copy ${selectedCatalogEntry.baseUrl}. Configure the key under Provider first.`}
          </p>
        ) : null}

        {selectedProvider === CUSTOM_PROVIDER_ID ? (
          <SettingsRow stacked label="Base URL">
            <input
              value={baseUrlDraft}
              onChange={(e) =>
                setEnvDraft((prev) => ({
                  ...prev,
                  ANTHROPIC_BASE_URL: e.target.value,
                }))
              }
              placeholder="https://gateway.example.com"
              className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
            />
          </SettingsRow>
        ) : null}

        <SettingsRow
          stacked
          label="Auth"
          description="API key for direct Anthropic; auth token for a proxy/gateway."
        >
          <div className="space-y-3">
            <Tabs
              value={authMode}
              onValueChange={(value) => {
                setAuthMode(value as AuthMode)
                setSecretDirty(false)
                const hasSecret = Boolean(
                  envDraft.ANTHROPIC_AUTH_TOKEN?.trim() ||
                    envDraft.ANTHROPIC_API_KEY?.trim(),
                )
                setSecretDraft(hasSecret ? SECRET_MASK : '')
              }}
            >
              <TabsList variant="default" className="w-full justify-start">
                <TabsTab value="api_key">API key</TabsTab>
                <TabsTab value="auth_token">Auth token</TabsTab>
              </TabsList>
            </Tabs>
            {!isCatalogProvider ? (
              <input
                type="password"
                value={secretDraft}
                onChange={(e) => {
                  setSecretDraft(e.target.value)
                  setSecretDirty(true)
                }}
                placeholder={
                  authMode === 'auth_token' ? 'gateway token…' : 'sk-ant-…'
                }
                className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
              />
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Default model"
        description="Saved as the model field in ~/.claude/settings.json."
        icon={SourceCodeSquareIcon}
      >
        <SettingsRow stacked label="Model alias">
          <div className="space-y-2">
            <select
              value={modelIsCustom ? '__custom__' : selectedModel}
              onChange={(e) => {
                const value = e.target.value
                setSelectedModel(value)
                if (value !== '__custom__') setCustomModel('')
              }}
              className={SETTINGS_CONTROL_CLASS}
            >
              <option value="">Select model…</option>
              {DEFAULT_MODEL_ALIASES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
            {modelIsCustom ? (
              <input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="e.g. claude-opus-4-8"
                className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
              />
            ) : null}
            {resolvedModelPreview &&
            resolvedModelPreview !== effectiveModel ? (
              <p className="text-xs text-primary-600">
                Resolves to{' '}
                <span className="font-mono">{resolvedModelPreview}</span>
              </p>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Pin alias versions"
        description="Map each alias to a concrete model id from the selected provider."
        icon={Settings02Icon}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {ALIAS_PINS.map(({ alias, envKey, label }) => {
            const known = pinModelOptions(
              alias,
              selectedProvider,
              selectedCatalogEntry?.models ?? [],
            )
            const value = envDraft[envKey as keyof EnvDraft]?.trim() || ''
            const isCustom =
              value && !known.includes(value) ? '__custom__' : value
            return (
              <SettingsRow key={envKey} stacked label={label}>
                <div className="space-y-2">
                  <select
                    value={isCustom}
                    onChange={(e) => {
                      const next = e.target.value
                      setEnvDraft((prev) => ({
                        ...prev,
                        [envKey]: next === '__custom__' ? '' : next,
                      }))
                      if (next !== '__custom__') {
                        setCustomPins((prev) => {
                          const copy = { ...prev }
                          delete copy[envKey]
                          return copy
                        })
                      }
                    }}
                    className={SETTINGS_CONTROL_CLASS}
                  >
                    <option value="">Default / not pinned</option>
                    {known.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                    <option value="__custom__">Custom…</option>
                  </select>
                  {isCustom === '__custom__' ? (
                    <input
                      value={customPins[envKey] || value}
                      onChange={(e) =>
                        setCustomPins((prev) => ({
                          ...prev,
                          [envKey]: e.target.value,
                        }))
                      }
                      onBlur={() => {
                        setEnvDraft((prev) => ({
                          ...prev,
                          [envKey]: (customPins[envKey] || '').trim() || value,
                        }))
                      }}
                      placeholder={`${alias} deployment id`}
                      className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
                    />
                  ) : null}
                </div>
              </SettingsRow>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Subagent model"
        description="CLAUDE_CODE_SUBAGENT_MODEL for subagents, teams, and workflows."
        icon={SourceCodeSquareIcon}
      >
        <SettingsRow stacked label="Subagent / workflow">
          <select
            value={envDraft.CLAUDE_CODE_SUBAGENT_MODEL?.trim() || ''}
            onChange={(e) =>
              setEnvDraft((prev) => ({
                ...prev,
                CLAUDE_CODE_SUBAGENT_MODEL: e.target.value,
              }))
            }
            className={SETTINGS_CONTROL_CLASS}
          >
            <option value="">Default / not set</option>
            {SUBAGENT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsSection>

      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={saving || !effectiveModel}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
