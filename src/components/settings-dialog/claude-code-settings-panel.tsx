'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
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

/** Sentinel shown in the API key field after reusing a catalog key — never a real secret. */
const SECRET_MASK = '••••'

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

export function ClaudeCodeSettingsPanel({
  agentId,
  onSaved,
}: ClaudeCodeSettingsPanelProps) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [selectedProvider, setSelectedProvider] = useState(DIRECT_ANTHROPIC_ID)
  const [envDraft, setEnvDraft] = useState<EnvDraft>({})
  const [customPins, setCustomPins] = useState<Record<string, string>>({})
  const [catalogProviders, setCatalogProviders] = useState<
    Array<CatalogProviderLite>
  >([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>('api_key')
  const [keyDirty, setKeyDirty] = useState({
    ANTHROPIC_API_KEY: false,
    ANTHROPIC_AUTH_TOKEN: false,
  })

  const baseUrlDraft = envDraft.ANTHROPIC_BASE_URL?.trim() || ''

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
        const pinned =
          customPins[envKey]?.trim() || envDraft[envKey as keyof EnvDraft]?.trim()
        if (pinned) return pinned
      }
    }
    return effectiveModel
  }, [effectiveModel, envDraft, customPins])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    fetch('/api/claude-code/settings')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const snapshot = data as {
          settings?: { model?: string; env?: EnvDraft }
          currentModel?: string
          currentProvider?: string
          catalogProviders?: Array<CatalogProviderLite>
        }
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

        // Restore auth mode from saved env: AUTH_TOKEN takes precedence over API_KEY
        // when both are present, because that's the proxy/gateway pattern.
        const hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim())
        const hasApiKey = Boolean(env.ANTHROPIC_API_KEY?.trim())
        setAuthMode(hasAuthToken ? 'auth_token' : hasApiKey ? 'api_key' : 'api_key')
        setKeyDirty({
          ANTHROPIC_API_KEY: false,
          ANTHROPIC_AUTH_TOKEN: false,
        })

        const anthropicEntry = catalog.find((p) => p.id === 'anthropic')
        let provider = CUSTOM_PROVIDER_ID
        if (!baseUrl) {
          provider = anthropicEntry ? 'anthropic' : DIRECT_ANTHROPIC_ID
        } else {
          const match = catalog.find(
            (p) =>
              p.baseUrl.trim() &&
              normalizeClaudeBaseUrl(p.baseUrl) === baseUrl,
          )
          if (match) provider = match.id
        }
        setSelectedProvider(provider)

        const providerModels =
          provider === CUSTOM_PROVIDER_ID || provider === DIRECT_ANTHROPIC_ID
            ? []
            : catalog.find((p) => p.id === provider)?.models ?? []
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
      })
      .catch(() => {
        if (!cancelled) setMsg('Failed to load settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleReuseCatalogKey = async (providerId: string) => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/api/claude-code/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copyFromCatalogProvider: providerId,
          authMode,
        }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        settings?: { env?: EnvDraft }
        currentModel?: string
        currentProvider?: string
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Failed to reuse key')
      }
      const nextEnv = data.settings?.env ?? {}
      setEnvDraft((prev) => ({
        ...prev,
        ANTHROPIC_BASE_URL: normalizeClaudeBaseUrl(
          (nextEnv.ANTHROPIC_BASE_URL as string | undefined) ??
            prev.ANTHROPIC_BASE_URL ??
            '',
        ),
        ...(authMode === 'auth_token'
          ? {
              ANTHROPIC_AUTH_TOKEN: SECRET_MASK,
              ANTHROPIC_API_KEY: '',
            }
          : {
              ANTHROPIC_API_KEY: SECRET_MASK,
              ANTHROPIC_AUTH_TOKEN: '',
            }),
      }))
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              currentModel: data.currentModel,
              currentProvider: data.currentProvider,
            }
          : prev,
      )
      setMsg('已从 Hermes Model & Provider 复用 base URL 和 API key')
      void queryClient.invalidateQueries({
        queryKey: ['claude-code', 'settings'],
      })
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to reuse key')
    }
    setSaving(false)
  }

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

      const baseUrlToSave = normalizeClaudeBaseUrl(
        mergedEnv.ANTHROPIC_BASE_URL?.trim() || '',
      )
      const authTokenDraft = mergedEnv.ANTHROPIC_AUTH_TOKEN?.trim() || ''
      const apiKeyDraft = mergedEnv.ANTHROPIC_API_KEY?.trim() || ''

      // When the key input still contains the mask placeholder the user has
      // not actually re-typed it; keep the existing secret instead of writing
      // the placeholder to disk.
      const activeKeyEnv =
        authMode === 'auth_token'
          ? ('ANTHROPIC_AUTH_TOKEN' as const)
          : ('ANTHROPIC_API_KEY' as const)
      const activeKeyDirty =
        authMode === 'auth_token'
          ? keyDirty.ANTHROPIC_AUTH_TOKEN
          : keyDirty.ANTHROPIC_API_KEY
      const activeKeyValue =
        authMode === 'auth_token' ? authTokenDraft : apiKeyDraft

      const envPatch: Record<string, string | null | undefined> = {
        ANTHROPIC_BASE_URL:
          selectedProvider === DIRECT_ANTHROPIC_ID
            ? null
            : baseUrlToSave || null,
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

      // Only overwrite the active auth key when the user has actually typed
      // into the input. If the field still shows the masked placeholder, leave
      // the on-disk secret untouched.
      if (activeKeyDirty) {
        envPatch[activeKeyEnv] = activeKeyValue || null
      }

      const res = await fetch('/api/claude-code/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: effectiveModel || null,
          env: envPatch,
        }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        currentModel?: string
        currentProvider?: string
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Save failed')
      }
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              model: effectiveModel,
              currentModel: data.currentModel,
              currentProvider: data.currentProvider,
              env: { ...envDraft },
            }
          : prev,
      )
      setMsg('Saved')

      void queryClient.invalidateQueries({
        queryKey: ['claude-code', 'models'],
      })
      void queryClient.invalidateQueries({
        queryKey: ['claude-code', 'settings'],
      })

      // Re-fetch the canonical masked snapshot so resolved model / provider
      // readouts always reflect what was actually written to disk.
      void fetch('/api/claude-code/settings')
        .then((r) => r.json())
        .then((fresh: { settings?: { model?: string; env?: EnvDraft }; currentModel?: string; currentProvider?: string }) => {
          setSettings({
            model: fresh.settings?.model,
            currentModel: fresh.currentModel,
            currentProvider: fresh.currentProvider,
            env: fresh.settings?.env ?? {},
          })
        })
        .catch(() => {
          // Non-fatal: the optimistic update above already updated the UI.
        })

      onSaved?.()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }

  if (loading) {
    return (
      <div
        className="h-20 animate-pulse rounded-lg"
        style={{ backgroundColor: 'var(--theme-panel)' }}
      />
    )
  }

  return (
    <div className="space-y-4">
      {msg && (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            msg.includes('Failed') || msg.includes('fail')
              ? 'bg-red-500/15 text-red-400'
              : 'bg-green-500/15 text-green-400',
          )}
        >
          {msg}
        </div>
      )}

      <div className="space-y-3 rounded-xl px-3 py-2.5" style={cardStyle}>
        <p
          className="text-xs font-semibold uppercase tracking-wider"
          style={mutedStyle}
        >
          Provider
        </p>
        <p className="text-[11px]" style={mutedStyle}>
          从 Hermes Model &amp; Provider 页面已配置的 provider 中选择，或手动填写。API
          key 和 base URL 保存在 ~/.claude/settings.json 的 <code>env</code> 下。
        </p>
        <select
          value={selectedProvider}
          onChange={(e) => {
            const id = e.target.value
            setSelectedProvider(id)
            if (id === DIRECT_ANTHROPIC_ID) {
              setEnvDraft((prev) => ({ ...prev, ANTHROPIC_BASE_URL: '' }))
            } else if (id !== CUSTOM_PROVIDER_ID) {
              const entry = catalogProviders.find((p) => p.id === id)
              setEnvDraft((prev) => ({
                ...prev,
                ANTHROPIC_BASE_URL: normalizeClaudeBaseUrl(entry?.baseUrl || ''),
              }))
            }
          }}
          className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.catalog ? '' : p.id === DIRECT_ANTHROPIC_ID ? '（直连）' : ''}
            </option>
          ))}
        </select>

        {selectedProvider === CUSTOM_PROVIDER_ID && (
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={mutedStyle}>
              Base URL
            </span>
            <input
              value={baseUrlDraft}
              onChange={(e) =>
                setEnvDraft((prev) => ({
                  ...prev,
                  ANTHROPIC_BASE_URL: e.target.value,
                }))
              }
              placeholder="https://api.anthropic.com or your gateway"
              className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </label>
        )}

        {selectedCatalogEntry?.baseUrl && (
          <p className="text-[11px]" style={mutedStyle}>
            Base URL（来自 Hermes 配置）：
            <code>{selectedCatalogEntry.baseUrl}</code>
          </p>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs font-medium" style={mutedStyle}>
              <input
                type="radio"
                name="authMode"
                value="api_key"
                checked={authMode === 'api_key'}
                onChange={() => {
                  setAuthMode('api_key')
                  setKeyDirty((prev) => ({ ...prev, ANTHROPIC_API_KEY: false }))
                }}
                className="accent-primary-600"
                />
                API key（直连 Anthropic）
            </label>
            <label className="flex items-center gap-1.5 text-xs font-medium" style={mutedStyle}>
              <input
                type="radio"
                name="authMode"
                value="auth_token"
                checked={authMode === 'auth_token'}
                onChange={() => {
                  setAuthMode('auth_token')
                  setKeyDirty((prev) => ({ ...prev, ANTHROPIC_AUTH_TOKEN: false }))
                }}
                className="accent-primary-600"
              />
              Auth token（代理/网关）
            </label>
          </div>

          {authMode === 'api_key' ? (
            <input
              type="password"
              value={envDraft.ANTHROPIC_API_KEY || ''}
              onChange={(e) => {
                setEnvDraft((prev) => ({
                  ...prev,
                  ANTHROPIC_API_KEY: e.target.value,
                }))
                setKeyDirty((prev) => ({ ...prev, ANTHROPIC_API_KEY: true }))
              }}
              placeholder="sk-ant-..."
              className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          ) : (
            <input
              type="password"
              value={envDraft.ANTHROPIC_AUTH_TOKEN || ''}
              onChange={(e) => {
                setEnvDraft((prev) => ({
                  ...prev,
                  ANTHROPIC_AUTH_TOKEN: e.target.value,
                }))
                setKeyDirty((prev) => ({ ...prev, ANTHROPIC_AUTH_TOKEN: true }))
              }}
              placeholder="gateway token..."
              className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          )}
        </div>

        {selectedCatalogEntry?.keyConfigured && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
            style={{ backgroundColor: 'var(--theme-panel)' }}
          >
            <p className="text-[11px]" style={mutedStyle}>
              Hermes Model &amp; Provider 页面已配置该 provider 的 key（
              {selectedCatalogEntry.maskedKey}）。
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => void handleReuseCatalogKey(selectedCatalogEntry.id)}
            >
              复用
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-xl px-3 py-2.5" style={cardStyle}>
        <p
          className="text-xs font-semibold uppercase tracking-wider"
          style={mutedStyle}
        >
          Default model
        </p>
        <p className="text-[11px]" style={mutedStyle}>
          Saved to ~/.claude/settings.json as the <code>model</code> field.
        </p>
        <select
          value={modelIsCustom ? '__custom__' : selectedModel}
          onChange={(e) => {
            const value = e.target.value
            setSelectedModel(value)
            if (value !== '__custom__') {
              setCustomModel('')
            }
          }}
          className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <option value="">Select model…</option>
          {DEFAULT_MODEL_ALIASES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {modelIsCustom && (
          <input
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="e.g. claude-opus-4-8 or my-deployment-id"
            className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={mutedStyle}>
              Resolved model
            </span>
            <input
              value={resolvedModelPreview || settings?.currentModel || ''}
              readOnly
              title={resolvedModelPreview || settings?.currentModel || ''}
              className="h-9 w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 font-mono text-sm text-[var(--theme-text)] outline-none"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium" style={mutedStyle}>
              Provider
            </span>
            <input
              value={
                providerOptions.find((p) => p.id === selectedProvider)?.name ||
                settings?.currentProvider ||
                'claude-code'
              }
              readOnly
              className="h-9 w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-input)] px-3 font-mono text-sm text-[var(--theme-text)] outline-none"
            />
          </label>
        </div>
      </div>

      <div className="space-y-3 rounded-xl px-3 py-2.5" style={cardStyle}>
        <p
          className="text-xs font-semibold uppercase tracking-wider"
          style={mutedStyle}
        >
          Pin alias versions
        </p>
        <p className="text-[11px]" style={mutedStyle}>
          Choose which full model id each alias resolves to. Options come from
          the selected provider&apos;s configured models; pick &quot;Custom&quot;
          for anything else.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
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
              <div key={envKey} className="space-y-1">
                <span className="text-xs font-medium" style={mutedStyle}>
                  {label}
                </span>
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
                  className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                >
                  <option value="">Default / not pinned</option>
                  {known.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
                {isCustom === '__custom__' && (
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
                    className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 font-mono text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-3 rounded-xl px-3 py-2.5" style={cardStyle}>
        <p
          className="text-xs font-semibold uppercase tracking-wider"
          style={mutedStyle}
        >
          Subagent / workflow model
        </p>
        <p className="text-[11px]" style={mutedStyle}>
          Saved to <code>CLAUDE_CODE_SUBAGENT_MODEL</code>. Controls subagents,
          agent teams, and workflow runs.
        </p>
        <select
          value={envDraft.CLAUDE_CODE_SUBAGENT_MODEL?.trim() || ''}
          onChange={(e) =>
            setEnvDraft((prev) => ({
              ...prev,
              CLAUDE_CODE_SUBAGENT_MODEL: e.target.value,
            }))
          }
          className="h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm text-primary-900 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <option value="">Default / not set</option>
          {SUBAGENT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={saving || !effectiveModel}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div className="rounded-lg border border-primary-200 bg-primary-50/80 px-3 py-2 text-xs text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        Provider is derived from <code>ANTHROPIC_BASE_URL</code> when set;
        otherwise requests go directly to Anthropic API. See the{' '}
        <a
          href="https://code.claude.com/docs/zh-CN/model-config"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          Claude Code model config docs
        </a>{' '}
        for details on aliases, pinned models, and third-party deployments.
      </div>
    </div>
  )
}
