'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  mergeProviderCards,
  type ExtraCatalogProvider,
} from '@/components/settings-dialog/model-provider-panel'
import { profileConfigPathLabel } from '@/lib/model-provider'
import { cn } from '@/lib/utils'

type ProfileModelSelectorProps = {
  profileName: string
  profileNames: Array<string>
  activeProfileName: string
  isReady: boolean
  defaultProvider: string
  defaultModel: string
  fallbackProvider: string
  fallbackModel: string
  catalogProviders: Array<ExtraCatalogProvider>
  loaded: boolean
  loadError: string | null
  message: string | null
  onProfileChange: (name: string) => void
  onSaveDefault: (providerId: string, modelId: string) => Promise<void>
  onSaveFallback: (providerId: string, modelId: string) => Promise<void>
  onClearFallback: () => Promise<void>
}

const selectClassName =
  'control-surface h-9 w-full rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]/35'

export function ProfileModelSelector({
  profileName,
  profileNames,
  activeProfileName,
  isReady,
  defaultProvider,
  defaultModel,
  fallbackProvider,
  fallbackModel,
  catalogProviders,
  loaded,
  loadError,
  message,
  onProfileChange,
  onSaveDefault,
  onSaveFallback,
  onClearFallback,
}: ProfileModelSelectorProps) {
  const providerOptions = useMemo(
    () => mergeProviderCards(catalogProviders),
    [catalogProviders],
  )

  const [draftDefaultProvider, setDraftDefaultProvider] =
    useState(defaultProvider)
  const [draftDefaultModel, setDraftDefaultModel] = useState(defaultModel)
  const [draftFallbackProvider, setDraftFallbackProvider] =
    useState(fallbackProvider)
  const [draftFallbackModel, setDraftFallbackModel] = useState(fallbackModel)
  const [defaultModels, setDefaultModels] = useState<Array<string>>([])
  const [fallbackModels, setFallbackModels] = useState<Array<string>>([])
  const [saving, setSaving] = useState<'default' | 'fallback' | 'clear' | null>(
    null,
  )

  useEffect(() => {
    setDraftDefaultProvider(defaultProvider)
    setDraftDefaultModel(defaultModel)
    setDraftFallbackProvider(fallbackProvider)
    setDraftFallbackModel(fallbackModel)
  }, [
    defaultModel,
    defaultProvider,
    fallbackModel,
    fallbackProvider,
    profileName,
  ])

  const fetchModels = useCallback(
    async (providerId: string, catalog: Array<ExtraCatalogProvider>) => {
      if (!providerId) return [] as Array<string>
      const catalogEntry = catalog.find((entry) => entry.id === providerId)
      try {
        const res = await fetch(
          `/api/hermes-proxy/api/available-models?provider=${encodeURIComponent(providerId)}`,
        )
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ id: string }> }
          const remote = (data.models || []).map((model) => model.id)
          if (remote.length > 0) {
            return [...new Set([...remote, ...(catalogEntry?.models || [])])]
          }
        }
      } catch {
        // fall through
      }
      // Fallback: fetch full model catalog and filter by provider
      try {
        const res = await fetch('/api/models')
        if (res.ok) {
          const data = (await res.json()) as {
            models?: Array<{ id: string; provider?: string }>
          }
          const filtered = (data.models || [])
            .filter((m) => m.provider === providerId)
            .map((m) => m.id)
          if (filtered.length > 0) {
            return [...new Set([...filtered, ...(catalogEntry?.models || [])])]
          }
        }
      } catch {
        // fall through to catalog / card defaults
      }
      const card = mergeProviderCards(catalog).find(
        (entry) => entry.id === providerId,
      )
      return [
        ...new Set([...(catalogEntry?.models || []), ...(card?.models || [])]),
      ]
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    void fetchModels(draftDefaultProvider, catalogProviders).then((models) => {
      if (!cancelled) setDefaultModels(models)
    })
    return () => {
      cancelled = true
    }
  }, [catalogProviders, draftDefaultProvider, fetchModels])

  useEffect(() => {
    let cancelled = false
    void fetchModels(draftFallbackProvider, catalogProviders).then((models) => {
      if (!cancelled) setFallbackModels(models)
    })
    return () => {
      cancelled = true
    }
  }, [catalogProviders, draftFallbackProvider, fetchModels])

  const panelStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }

  const renderProviderSelect = (
    value: string,
    onChange: (next: string) => void,
  ) => (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={selectClassName}
    >
      <option value="">Select provider</option>
      {providerOptions.map((provider) => (
        <option key={provider.id} value={provider.id}>
          {provider.name}
          {provider.source === 'catalog' ? ' (custom)' : ''}
        </option>
      ))}
    </select>
  )

  const renderModelSelect = (
    providerId: string,
    value: string,
    models: Array<string>,
    onChange: (next: string) => void,
  ) => (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={selectClassName + ' font-mono'}
      disabled={!providerId}
    >
      <option value="">
        {providerId ? 'Select model' : 'Pick a provider first'}
      </option>
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
      {value && !models.includes(value) ? (
        <option value={value}>{value}</option>
      ) : null}
    </select>
  )

  return (
    <div className="space-y-4 rounded-xl p-4" style={panelStyle}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p
            className="text-sm font-semibold"
            style={{ color: 'var(--theme-text)' }}
          >
            Profile selection
          </p>
          <p className="text-xs leading-relaxed" style={mutedStyle}>
            Choose which provider and model this profile uses. Provider URLs and
            keys are configured in the card grid above.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={profileName}
            onChange={(event) => onProfileChange(event.target.value)}
            className={selectClassName}
          >
            {profileNames.map((name) => (
              <option key={name} value={name}>
                {name}
                {name === activeProfileName ? ' (active)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!isReady || profileName === activeProfileName}
            onClick={() => onProfileChange(activeProfileName)}
            className={cn(
              'control-surface h-9 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-[var(--theme-card2)]',
              (!isReady || profileName === activeProfileName) && 'opacity-50',
            )}
          >
            Use active profile
          </button>
        </div>
      </div>

      <p className="text-[11px] font-mono" style={mutedStyle}>
        Writes to {profileConfigPathLabel(profileName)}
      </p>

      {loadError ? (
        <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm font-medium text-red-500 dark:text-red-400">
          {loadError}
        </div>
      ) : null}
      {message ? (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            message.includes('Failed')
              ? 'bg-red-500/15 text-red-500 dark:text-red-400'
              : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          )}
        >
          {message}
        </div>
      ) : null}

      {!loaded ? (
        <div
          className="h-24 animate-pulse rounded-xl"
          style={{ backgroundColor: 'var(--theme-panel)' }}
        />
      ) : (
        <div className="space-y-4">
          <div
            className="space-y-2 rounded-lg p-3"
            style={{ backgroundColor: 'var(--theme-panel)' }}
          >
            <p
              className="text-xs font-semibold uppercase tracking-wider"
              style={mutedStyle}
            >
              Default model
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium" style={mutedStyle}>
                  Provider
                </span>
                {renderProviderSelect(draftDefaultProvider, (next) => {
                  setDraftDefaultProvider(next)
                  setDraftDefaultModel('')
                })}
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium" style={mutedStyle}>
                  Model
                </span>
                {renderModelSelect(
                  draftDefaultProvider,
                  draftDefaultModel,
                  defaultModels,
                  setDraftDefaultModel,
                )}
              </label>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={
                  saving !== null ||
                  !draftDefaultProvider.trim() ||
                  !draftDefaultModel.trim()
                }
                onClick={() => {
                  void (async () => {
                    setSaving('default')
                    try {
                      await onSaveDefault(
                        draftDefaultProvider.trim(),
                        draftDefaultModel.trim(),
                      )
                    } finally {
                      setSaving(null)
                    }
                  })()
                }}
              >
                {saving === 'default' ? 'Saving…' : 'Save default'}
              </Button>
            </div>
          </div>

          <div
            className="space-y-2 rounded-lg p-3"
            style={{ backgroundColor: 'var(--theme-panel)' }}
          >
            <p
              className="text-xs font-semibold uppercase tracking-wider"
              style={mutedStyle}
            >
              Fallback model (optional)
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium" style={mutedStyle}>
                  Provider
                </span>
                {renderProviderSelect(draftFallbackProvider, (next) => {
                  setDraftFallbackProvider(next)
                  setDraftFallbackModel('')
                })}
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium" style={mutedStyle}>
                  Model
                </span>
                {renderModelSelect(
                  draftFallbackProvider,
                  draftFallbackModel,
                  fallbackModels,
                  setDraftFallbackModel,
                )}
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  saving !== null ||
                  (!fallbackProvider && !draftFallbackProvider)
                }
                onClick={() => {
                  void (async () => {
                    setSaving('clear')
                    try {
                      await onClearFallback()
                      setDraftFallbackProvider('')
                      setDraftFallbackModel('')
                    } finally {
                      setSaving(null)
                    }
                  })()
                }}
              >
                {saving === 'clear' ? 'Clearing…' : 'Clear fallback'}
              </Button>
              <Button
                size="sm"
                disabled={
                  saving !== null ||
                  !draftFallbackProvider.trim() ||
                  !draftFallbackModel.trim()
                }
                onClick={() => {
                  void (async () => {
                    setSaving('fallback')
                    try {
                      await onSaveFallback(
                        draftFallbackProvider.trim(),
                        draftFallbackModel.trim(),
                      )
                    } finally {
                      setSaving(null)
                    }
                  })()
                }}
              >
                {saving === 'fallback' ? 'Saving…' : 'Save fallback'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
