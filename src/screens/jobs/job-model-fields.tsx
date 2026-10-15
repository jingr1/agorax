'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchJobModelCatalog,
  fetchModelsForJobProvider,
} from '@/lib/job-model-catalog'
import type { JobModelPinMode } from './job-form-types'

type JobModelFieldsProps = {
  modelPin: JobModelPinMode
  provider: string
  model: string
  inheritedLabel?: string | null
  onModelPinChange: (mode: JobModelPinMode) => void
  onProviderChange: (provider: string) => void
  onModelChange: (model: string) => void
}

const selectClassName =
  'control-surface w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)]/35'

export function JobModelFields({
  modelPin,
  provider,
  model,
  inheritedLabel,
  onModelPinChange,
  onProviderChange,
  onModelChange,
}: JobModelFieldsProps) {
  const catalogQuery = useQuery({
    queryKey: ['jobs', 'model-catalog'],
    queryFn: fetchJobModelCatalog,
    staleTime: 60_000,
  })

  const [remoteModels, setRemoteModels] = useState<Array<string>>([])

  const providerOptions = useMemo(
    () => catalogQuery.data?.providers ?? [],
    [catalogQuery.data?.providers],
  )

  const catalogModels = useMemo(() => {
    if (!provider.trim()) return []
    return catalogQuery.data?.modelsByProvider[provider] ?? []
  }, [catalogQuery.data?.modelsByProvider, provider])

  useEffect(() => {
    if (!provider.trim() || catalogModels.length > 0) {
      setRemoteModels([])
      return
    }

    let cancelled = false
    void fetchModelsForJobProvider(provider, catalogQuery.data).then(
      (models) => {
        if (!cancelled) setRemoteModels(models)
      },
    )

    return () => {
      cancelled = true
    }
  }, [catalogModels.length, catalogQuery.data, provider])

  const modelOptions = useMemo(() => {
    const merged = new Set([...catalogModels, ...remoteModels])
    if (model.trim()) merged.add(model.trim())
    return Array.from(merged).sort((a, b) => a.localeCompare(b))
  }, [catalogModels, model, remoteModels])

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Model</h3>
        <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
          Pin a model for this job, or inherit the selected profile default.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onModelPinChange('inherit')}
          className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background:
              modelPin === 'inherit'
                ? 'var(--theme-accent)'
                : 'var(--theme-card)',
            borderColor:
              modelPin === 'inherit'
                ? 'var(--theme-accent)'
                : 'var(--theme-border)',
            color: modelPin === 'inherit' ? '#fff' : 'var(--theme-text)',
          }}
        >
          Profile default
        </button>
        <button
          type="button"
          onClick={() => onModelPinChange('pinned')}
          className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background:
              modelPin === 'pinned'
                ? 'var(--theme-accent)'
                : 'var(--theme-card)',
            borderColor:
              modelPin === 'pinned'
                ? 'var(--theme-accent)'
                : 'var(--theme-border)',
            color: modelPin === 'pinned' ? '#fff' : 'var(--theme-text)',
          }}
        >
          Pin model
        </button>
      </div>

      {modelPin === 'inherit' ? (
        <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
          {inheritedLabel
            ? `Currently resolves to ${inheritedLabel}.`
            : 'Uses cron.model or the profile default from config.yaml.'}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-2">
            <span className="text-sm font-medium">Provider</span>
            <select
              value={provider}
              onChange={(event) => {
                onProviderChange(event.target.value)
                onModelChange('')
              }}
              required
              className={selectClassName}
              style={{ color: 'var(--theme-text)' }}
            >
              <option value="">Select provider</option>
              {providerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
              {provider &&
              !providerOptions.some((option) => option.id === provider) ? (
                <option value={provider}>{provider}</option>
              ) : null}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <select
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              required
              disabled={!provider}
              className={selectClassName}
              style={{ color: 'var(--theme-text)' }}
            >
              <option value="">
                {provider ? 'Select model' : 'Pick a provider first'}
              </option>
              {modelOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {catalogQuery.isError ? (
        <p className="text-xs" style={{ color: 'var(--theme-warning)' }}>
          Model catalog failed to load. You can still type provider/model IDs if
          they appear after refresh.
        </p>
      ) : null}
    </section>
  )
}
