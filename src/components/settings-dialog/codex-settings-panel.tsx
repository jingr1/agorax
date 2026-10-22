'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CloudIcon, SourceCodeSquareIcon } from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import {
  SETTINGS_CONTROL_CLASS,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-section'
import { cn } from '@/lib/utils'

type CatalogProviderLite = {
  id: string
  name: string
  baseUrl: string
  models: Array<string>
  keyConfigured: boolean
  maskedKey: string
}

type CodexConfigSnapshot = {
  model: string
  provider: string
  providerName: string
  configPath: string
  catalogProviders: Array<CatalogProviderLite>
  availableModels: Array<{ id: string; name: string; provider: string }>
}

export type CodexSettingsPanelProps = {
  agentId?: string
  onSaved?: () => void
}

const DIRECT_OPENAI_ID = '__openai_direct__'

export function CodexSettingsPanel({ onSaved }: CodexSettingsPanelProps) {
  const queryClient = useQueryClient()
  const [config, setConfig] = useState<CodexConfigSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [provider, setProvider] = useState('')

  const effectiveModel = useMemo(() => {
    if (model === '__custom__') return customModel.trim()
    return model
  }, [model, customModel])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    fetch('/api/agents/codex-impl/config')
      .then((r) => r.json())
      .then(
        (data: {
          ok?: boolean
          config?: CodexConfigSnapshot
          error?: string
        }) => {
          if (cancelled) return
          if (!data.ok || !data.config) {
            setMsg(data.error || 'Failed to load Codex config')
            setLoading(false)
            return
          }
          const snapshot = data.config
          setConfig(snapshot)
          setProvider(snapshot.provider || DIRECT_OPENAI_ID)

          const currentModel = snapshot.model
          const providerModels =
            snapshot.catalogProviders.find((p) => p.id === snapshot.provider)
              ?.models ??
            snapshot.availableModels.map((m) => m.id)
          if (currentModel && providerModels.includes(currentModel)) {
            setModel(currentModel)
            setCustomModel('')
          } else if (currentModel) {
            setModel('__custom__')
            setCustomModel(currentModel)
          } else {
            setModel('')
            setCustomModel('')
          }
          setLoading(false)
        },
      )
      .catch(() => {
        if (!cancelled) {
          setMsg('Failed to load Codex config')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const providerOptions = useMemo(() => {
    const catalog = config?.catalogProviders ?? []
    return [
      { id: DIRECT_OPENAI_ID, name: 'OpenAI (direct)' },
      ...catalog.map((p) => ({ id: p.id, name: p.name })),
    ]
  }, [config])

  const modelOptions = useMemo(() => {
    if (provider === DIRECT_OPENAI_ID) {
      return [
        'gpt-5.6-terra',
        'gpt-5.6',
        'gpt-4.1',
        'gpt-4o',
        'gpt-4o-mini',
        'o3-mini',
        'o1',
      ]
    }
    const catalogEntry = config?.catalogProviders.find((p) => p.id === provider)
    if (catalogEntry && catalogEntry.models.length > 0) {
      return catalogEntry.models
    }
    return config?.availableModels.map((m) => m.id) ?? []
  }, [provider, config])

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const body: {
        model?: string
        provider?: string
        copyFromCatalogProvider?: string
      } = {}
      if (effectiveModel) body.model = effectiveModel
      if (provider === DIRECT_OPENAI_ID) {
        body.provider = 'openai'
      } else if (provider) {
        body.copyFromCatalogProvider = provider
      }

      const res = await fetch('/api/agents/codex-impl/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        config?: CodexConfigSnapshot
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Save failed')
      }
      if (data.config) setConfig(data.config)
      setMsg('Saved')
      void queryClient.invalidateQueries({
        queryKey: ['composer', 'models'],
      })
      onSaved?.()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  if (loading) {
    return <div className="h-20 animate-pulse rounded-xl bg-primary-100/70" />
  }

  return (
    <div className="space-y-4">
      {msg ? (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            msg === 'Saved'
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-red-500/15 text-red-500 dark:text-red-400',
          )}
        >
          {msg}
        </div>
      ) : null}

      <SettingsSection
        title="Provider"
        description="Selecting a Provider copies its base URL and key into ~/.codex/config.toml."
        icon={CloudIcon}
      >
        <SettingsRow stacked label="Provider">
          <select
            value={provider}
            onChange={(e) => {
              const nextProvider = e.target.value
              setProvider(nextProvider)
              const nextModels =
                nextProvider === DIRECT_OPENAI_ID
                  ? [
                      'gpt-5.6-terra',
                      'gpt-5.6',
                      'gpt-4.1',
                      'gpt-4o',
                      'gpt-4o-mini',
                      'o3-mini',
                      'o1',
                    ]
                  : config?.catalogProviders.find((p) => p.id === nextProvider)
                      ?.models ?? []
              if (nextModels.length > 0 && !nextModels.includes(model)) {
                setModel(nextModels[0])
                setCustomModel('')
              }
            }}
            className={SETTINGS_CONTROL_CLASS}
          >
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Model"
        description="Default Codex model for this agent."
        icon={SourceCodeSquareIcon}
      >
        <SettingsRow stacked label="Model">
          <div className="space-y-2">
            <select
              value={model}
              onChange={(e) => {
                const value = e.target.value
                setModel(value)
                if (value !== '__custom__') setCustomModel('')
              }}
              className={SETTINGS_CONTROL_CLASS}
            >
              <option value="">Select model…</option>
              {modelOptions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
              <option value="__custom__">Custom</option>
            </select>
            {model === '__custom__' ? (
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="e.g. gpt-5.6-terra"
                className={cn(SETTINGS_CONTROL_CLASS, 'font-mono')}
              />
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
