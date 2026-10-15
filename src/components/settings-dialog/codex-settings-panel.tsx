'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
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

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }
  const inputClass =
    'h-9 w-full rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm text-primary-900 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'

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
            'rounded-lg px-3 py-1.5 text-xs font-medium',
            msg === 'Saved'
              ? 'bg-green-500/15 text-green-400'
              : 'bg-red-500/15 text-red-400',
          )}
        >
          {msg}
        </div>
      )}

      <div
        className="space-y-3 rounded-xl border px-4 py-3 shadow-sm"
        style={cardStyle}
      >
        <div>
          <label
            className="mb-1 block text-xs font-medium"
            style={mutedStyle}
          >
            Provider
          </label>
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
            className={inputClass}
          >
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px]" style={mutedStyle}>
            Selecting a Hermes Model &amp; Provider entry copies its base URL
            and API key into ~/.codex/config.toml as a{' '}
            <code>[model_providers.&lt;id&gt;]</code> block.
          </p>
        </div>

        <div>
          <label
            className="mb-1 block text-xs font-medium"
            style={mutedStyle}
          >
            Model
          </label>
          <select
            value={model}
            onChange={(e) => {
              const value = e.target.value
              setModel(value)
              if (value !== '__custom__') setCustomModel('')
            }}
            className={inputClass}
          >
            <option value="">— select model —</option>
            {modelOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            <option value="__custom__">Custom</option>
          </select>
          {model === '__custom__' && (
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. gpt-5.6-terra"
              className={cn(inputClass, 'mt-2')}
            />
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving}
          className="h-9 rounded-lg px-4 text-sm"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
