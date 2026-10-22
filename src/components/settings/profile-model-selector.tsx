'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AiBrain01Icon } from '@hugeicons/core-free-icons'
import type { ExtraCatalogProvider } from '@/components/settings-dialog/model-provider-panel'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  SETTINGS_CONTROL_CLASS,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-section'
import { mergeProviderCards } from '@/components/settings-dialog/model-provider-panel'
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
  /** When true, profile is pinned by the parent agent filter. */
  lockProfile?: boolean
  onProfileChange: (name: string) => void
  onSaveDefault: (providerId: string, modelId: string) => Promise<void>
  onSaveFallback: (providerId: string, modelId: string) => Promise<void>
  onClearFallback: () => Promise<void>
}

const selectClassName = SETTINGS_CONTROL_CLASS

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
  lockProfile = false,
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
        const params = new URLSearchParams({ provider: providerId })
        if (profileName.trim()) params.set('profile', profileName.trim())
        const res = await fetch(
          `/api/hermes-proxy/api/available-models?${params.toString()}`,
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
    [profileName],
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
      className={cn(selectClassName, 'font-mono')}
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
    <SettingsSection
      title={lockProfile ? 'Model' : 'Profile model'}
      description={
        lockProfile
          ? 'Default and optional fallback for this agent.'
          : 'Default and optional fallback for the selected profile.'
      }
      icon={AiBrain01Icon}
      trailing={
        lockProfile ? (
          <Badge variant="outline" className="font-mono font-normal">
            {profileName || 'default'}
          </Badge>
        ) : undefined
      }
    >
      {!lockProfile ? (
        <SettingsRow label="Profile" description="Which Hermes profile to edit.">
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
            <select
              value={profileName}
              onChange={(event) => onProfileChange(event.target.value)}
              className={cn(selectClassName, 'md:min-w-[10rem]')}
            >
              {profileNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {name === activeProfileName ? ' (active)' : ''}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!isReady || profileName === activeProfileName}
              onClick={() => onProfileChange(activeProfileName)}
            >
              Use active
            </Button>
          </div>
        </SettingsRow>
      ) : null}

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
        <div className="h-24 animate-pulse rounded-xl bg-primary-100/70" />
      ) : (
        <>
          <SettingsRow
            stacked
            label="Default"
            description="Primary provider and model for this agent."
          >
            <div className="grid w-full gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="space-y-1.5">
                <span className="text-xs text-primary-600">Provider</span>
                {renderProviderSelect(draftDefaultProvider, (next) => {
                  setDraftDefaultProvider(next)
                  setDraftDefaultModel('')
                })}
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-primary-600">Model</span>
                {renderModelSelect(
                  draftDefaultProvider,
                  draftDefaultModel,
                  defaultModels,
                  setDraftDefaultModel,
                )}
              </label>
              <Button
                size="sm"
                className="sm:mb-0.5"
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
                {saving === 'default' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </SettingsRow>

          <SettingsRow
            stacked
            label="Fallback"
            description="Optional · used when the default provider fails."
          >
            <div className="grid w-full gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="space-y-1.5">
                <span className="text-xs text-primary-600">Provider</span>
                {renderProviderSelect(draftFallbackProvider, (next) => {
                  setDraftFallbackProvider(next)
                  setDraftFallbackModel('')
                })}
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-primary-600">Model</span>
                {renderModelSelect(
                  draftFallbackProvider,
                  draftFallbackModel,
                  fallbackModels,
                  setDraftFallbackModel,
                )}
              </label>
              <div className="flex gap-1.5 sm:mb-0.5">
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
                  {saving === 'clear' ? 'Clearing…' : 'Clear'}
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
                  {saving === 'fallback' ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </SettingsRow>
        </>
      )}

      <p className="text-[11px] font-mono text-primary-600">
        {profileConfigPathLabel(profileName)}
      </p>
    </SettingsSection>
  )
}
